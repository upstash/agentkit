/**
 * Sandbox backend for **Eve** (`eve/sandbox`, https://eve.dev/docs/sandbox), powered by
 * **Upstash Box** (`@upstash/box`) — a serverless cloud sandbox for AI agents.
 *
 * `upstash()` is a drop-in replacement for Eve's `vercel()` backend: it returns a value implementing
 * Eve's real two-phase {@link SandboxBackend} (`name` / `prewarm` / `create`). Take any Eve sandbox
 * file and swap the backend import:
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox } from "eve/sandbox";
 * import { upstash } from "@upstash/agentkit-eve/sandbox"; // was: import { vercel } from "eve/sandbox/vercel"
 *
 * export default defineSandbox({
 *   backend: upstash({ runtime: "node24", resources: { vcpus: 2 } }),
 *   revalidationKey: () => "repo-bootstrap-v1",
 *   async bootstrap({ use }) {
 *     const sandbox = await use();
 *     await sandbox.run({ command: "apt-get install -y jq" });
 *   },
 *   async onSession({ use }) {
 *     await use({ networkPolicy: "deny-all" });
 *   },
 * });
 * ```
 *
 * The lifecycle maps onto Box like this: `prewarm` builds a template box (seed files + your
 * `bootstrap` hook) and captures a Box **snapshot**; `create` opens a live session from that snapshot
 * with `Box.fromSnapshot` (or a fresh `Box.create` when there's no template). The prewarmed snapshots
 * are cached on the backend instance, so use the factory form of `backend` to keep that cache warm.
 *
 * `@upstash/box` is an optional peer dependency — only needed when you import this entry point. This
 * backend is type-checked against Eve's real types but cannot be runtime-verified in this repo.
 */
import { Box } from "@upstash/box";
import type { BoxSize, NetworkPolicy as BoxNetworkPolicy, Runtime } from "@upstash/box";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
  SandboxBackendSessionState,
  SandboxBootstrapUseFn,
  SandboxNetworkPolicy,
  SandboxSession,
  SandboxSessionUseFn,
} from "eve/sandbox";

/** Per-session (and per-bootstrap) options a caller can apply via `use(options)`. */
export interface UpstashSandboxOptions {
  /** Network policy to apply to the session when it's opened. */
  networkPolicy?: SandboxNetworkPolicy;
}

export interface UpstashBackendConfig {
  /** Backend name (participates in Eve's cache-key derivation). Defaults to `"upstash"`. */
  name?: string;
  /** Upstash Box API key. Falls back to `UPSTASH_BOX_API_KEY`. */
  apiKey?: string;
  /** Box runtime. Accepts Eve-style strings like `"node24"` (mapped to Box's `"node"`). */
  runtime?: Runtime | string;
  /** Box resource size. Inferred from `resources.vcpus` when omitted. */
  size?: BoxSize;
  /** Vercel-style resource hint; `vcpus` maps to a Box size (2→small, 4→medium, 8→large). */
  resources?: { vcpus?: number };
  /** Keep the box alive between turns. Defaults to true. */
  keepAlive?: boolean;
  /** Startup script run once when a keep-alive box is created. */
  initCommand?: string;
  /** Environment variables available inside the box. */
  env?: Record<string, string>;
  /** Initial network policy applied to every session. */
  networkPolicy?: SandboxNetworkPolicy;
}

/** The directory Eve anchors relative sandbox paths to. */
const WORKSPACE = "/workspace";
const RUNTIMES = new Set<Runtime>(["node", "python", "golang", "ruby", "rust"]);

function toBoxRuntime(runtime?: Runtime | string): Runtime {
  if (!runtime) return "node";
  const base = runtime.replace(/[0-9.]+$/, ""); // "node24" -> "node"
  return (RUNTIMES.has(base as Runtime) ? base : "node") as Runtime;
}

function toBoxSize(config: UpstashBackendConfig): BoxSize {
  if (config.size) return config.size;
  const vcpus = config.resources?.vcpus ?? 0;
  if (vcpus >= 8) return "large";
  if (vcpus >= 4) return "medium";
  return "small";
}

/** Map Eve's (Vercel-shaped) network policy onto Box's network policy. */
function toBoxNetworkPolicy(policy: SandboxNetworkPolicy): BoxNetworkPolicy {
  if (policy === "allow-all") return { mode: "allow-all" };
  if (policy === "deny-all") return { mode: "deny-all" };
  const allow = policy.allow;
  const allowedDomains = Array.isArray(allow) ? allow : allow ? Object.keys(allow) : undefined;
  return {
    mode: "custom",
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(policy.subnets?.allow ? { allowedCidrs: policy.subnets.allow } : {}),
    ...(policy.subnets?.deny ? { deniedCidrs: policy.subnets.deny } : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build a shell command from the AI SDK run/spawn options (env + working directory + command). */
function buildCommand(options: {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
}): string {
  let cmd = options.command;
  if (options.env && Object.keys(options.env).length) {
    const env = Object.entries(options.env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    cmd = `${env} ${cmd}`;
  }
  if (options.workingDirectory) cmd = `cd ${shellQuote(options.workingDirectory)} && ${cmd}`;
  return cmd;
}

const toBase64 = (data: string | Uint8Array): string =>
  Buffer.from(data as Uint8Array).toString("base64");
const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Build Eve's public {@link SandboxSession} over a live Box. */
function buildSession(box: Box): SandboxSession {
  const resolvePath = (path: string): string =>
    path.startsWith("/") ? path : `${WORKSPACE}/${path}`;

  return {
    get id() {
      return box.id;
    },
    resolvePath,
    async run(options) {
      const run = await box.exec.command(buildCommand(options));
      const exitCode = run.exitCode ?? 0;
      const output = run.result ?? "";
      return { exitCode, stdout: output, stderr: exitCode === 0 ? "" : output };
    },
    async spawn(options) {
      // Box has no detached-process primitive, so run to completion and replay the output as streams.
      const run = await box.exec.command(buildCommand(options));
      const exitCode = run.exitCode ?? 0;
      const output = run.result ?? "";
      return {
        stdout: bytesToStream(new TextEncoder().encode(output)),
        stderr: bytesToStream(new TextEncoder().encode(exitCode === 0 ? "" : output)),
        wait: () => Promise.resolve({ exitCode }),
        kill: () => Promise.resolve(),
      };
    },
    async readFile({ path }) {
      try {
        return bytesToStream(
          fromBase64(await box.files.read(resolvePath(path), { encoding: "base64" })),
        );
      } catch {
        return null;
      }
    },
    async readBinaryFile({ path }) {
      try {
        return fromBase64(await box.files.read(resolvePath(path), { encoding: "base64" }));
      } catch {
        return null;
      }
    },
    async readTextFile({ path, startLine, endLine }) {
      try {
        const text = await box.files.read(resolvePath(path));
        if (startLine === undefined && endLine === undefined) return text;
        const lines = text.split("\n");
        return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
      } catch {
        return null;
      }
    },
    async writeFile({ path, content }) {
      const bytes = await streamToBytes(content);
      await box.files.write({
        path: resolvePath(path),
        content: toBase64(bytes),
        encoding: "base64",
      });
    },
    async writeBinaryFile({ path, content }) {
      await box.files.write({
        path: resolvePath(path),
        content: toBase64(content),
        encoding: "base64",
      });
    },
    async writeTextFile({ path, content }) {
      await box.files.write({ path: resolvePath(path), content });
    },
    async setNetworkPolicy(policy) {
      await box.updateNetworkPolicy(toBoxNetworkPolicy(policy));
    },
    async removePath({ path, force, recursive }) {
      const flags = `${recursive ? "r" : ""}${force ? "f" : ""}`;
      await box.exec.command(
        `rm ${flags ? `-${flags}` : ""} ${shellQuote(resolvePath(path))}`.trim(),
      );
    },
  };
}

/**
 * An Upstash Box implementation of Eve's two-phase {@link SandboxBackend}. Construct it via the
 * {@link upstash} factory and hand it to `defineSandbox({ backend })`.
 */
export class UpstashSandboxBackend implements SandboxBackend<
  UpstashSandboxOptions,
  UpstashSandboxOptions
> {
  readonly name: string;
  private readonly config: UpstashBackendConfig;
  /** templateKey → Box snapshot id, captured by `prewarm` and reused by `create`. */
  private readonly templates = new Map<string, string>();

  constructor(config: UpstashBackendConfig = {}) {
    this.config = config;
    this.name = config.name ?? "upstash";
  }

  private boxConfig() {
    return {
      ...(this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}),
      runtime: toBoxRuntime(this.config.runtime),
      size: toBoxSize(this.config),
      keepAlive: this.config.keepAlive ?? true,
      ...(this.config.initCommand !== undefined ? { initCommand: this.config.initCommand } : {}),
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
    };
  }

  async create(
    input: SandboxBackendCreateInput,
  ): Promise<SandboxBackendHandle<UpstashSandboxOptions>> {
    const snapshotId = input.templateKey ? this.templates.get(input.templateKey) : undefined;
    const box = snapshotId
      ? await Box.fromSnapshot(snapshotId, this.boxConfig())
      : await Box.create(this.boxConfig());

    if (this.config.networkPolicy) {
      await box.updateNetworkPolicy(toBoxNetworkPolicy(this.config.networkPolicy));
    }

    const session = buildSession(box);

    const useSessionFn: SandboxSessionUseFn<UpstashSandboxOptions> = async (options) => {
      if (options?.networkPolicy)
        await box.updateNetworkPolicy(toBoxNetworkPolicy(options.networkPolicy));
      return session;
    };

    const captureState = async (): Promise<SandboxBackendSessionState> => ({
      backendName: this.name,
      sessionKey: input.sessionKey,
      metadata: {
        boxId: box.id,
        ...(input.templateKey ? { templateKey: input.templateKey } : {}),
      },
    });

    const dispose = async (): Promise<void> => {
      if (this.config.keepAlive ?? true) await box.pause();
      else await box.delete();
    };

    return { session, useSessionFn, captureState, dispose };
  }

  async prewarm(
    input: SandboxBackendPrewarmInput<UpstashSandboxOptions>,
  ): Promise<{ reused: boolean }> {
    if (this.templates.has(input.templateKey)) return { reused: true };

    const box = await Box.create(this.boxConfig());
    try {
      const session = buildSession(box);

      for (const file of input.seedFiles) {
        const content = typeof file.content === "string" ? file.content : toBase64(file.content);
        await box.files.write({
          path: session.resolvePath(file.path),
          content,
          ...(typeof file.content === "string" ? {} : { encoding: "base64" as const }),
        });
      }

      if (input.bootstrap) {
        const use: SandboxBootstrapUseFn<UpstashSandboxOptions> = async (options) => {
          if (options?.networkPolicy) {
            await box.updateNetworkPolicy(toBoxNetworkPolicy(options.networkPolicy));
          }
          return session;
        };
        await input.bootstrap({ use });
      }

      const snapshot = await box.snapshot({ name: `agentkit-${input.templateKey}`.slice(0, 200) });
      this.templates.set(input.templateKey, snapshot.id);
      return { reused: false };
    } finally {
      await box.delete().catch(() => {});
    }
  }
}

/**
 * An Upstash Box backend for Eve's `defineSandbox`. Drop-in replacement for `vercel()`. Returns a
 * {@link UpstashSandboxBackend} implementing Eve's real `SandboxBackend`.
 */
export function upstash(
  config: UpstashBackendConfig = {},
): SandboxBackend<UpstashSandboxOptions, UpstashSandboxOptions> {
  return new UpstashSandboxBackend(config);
}
