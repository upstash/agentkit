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
 *   backend: upstash({ runtime: "node", size: "medium" }),
 *   revalidationKey: () => "repo-bootstrap-v1",
 *   async bootstrap({ use }) {
 *     // Network egress is denied by default — open it here because installing a package needs it.
 *     const sandbox = await use({ networkPolicy: "allow-all" });
 *     await sandbox.run({ command: "apt-get install -y jq" });
 *   },
 *   async onSession({ use }) {
 *     await use(); // sessions inherit the secure default (deny-all) unless you pass a networkPolicy
 *   },
 * });
 * ```
 *
 * **Network egress is denied by default** (see {@link DEFAULT_NETWORK_POLICY}); pass a `networkPolicy`
 * on the backend, in `bootstrap`'s `use(...)`, or in the session `use(...)` to open it. Note also that
 * `config.env` is injected into the box and is therefore readable by code running inside it — don't
 * pass secrets you wouldn't want model-generated code to see.
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
import type { BoxConfig, NetworkPolicy as BoxNetworkPolicy } from "@upstash/box";
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

/**
 * Configuration for the {@link upstash} backend — the **Upstash Box** `BoxConfig` as-is (`runtime`,
 * `size`, `apiKey`/`baseUrl`, `keepAlive`, `initCommand`, `env`, `git`, `skills`, `mcpServers`,
 * `timeout`, `debug`, `name`, …). Whatever you'd pass to `Box.create({...})` you pass here, so there
 * are no AgentKit-invented knobs to learn or keep in sync.
 *
 * `networkPolicy` is intentionally **omitted**: in Eve, network access is governed by the secure
 * deny-all default (see {@link DEFAULT_NETWORK_POLICY}) plus per-session `use({ networkPolicy })`, not
 * a backend-level knob. `name` doubles as the Eve backend name (it participates in cache-key
 * derivation; defaults to `"upstash"`).
 */
export type UpstashBackendConfig = Omit<BoxConfig, "networkPolicy">;

/** The directory Eve anchors relative sandbox paths to. */
const WORKSPACE = "/workspace";

/**
 * Secure default: deny all network egress unless the caller opts in via `networkPolicy` (on the
 * backend, the bootstrap `use(...)`, or the session `use(...)`). An agent sandbox runs untrusted,
 * model-generated code, so open egress would mean SSRF / data exfiltration / reaching your own
 * infrastructure from inside the box by default.
 */
const DEFAULT_NETWORK_POLICY: SandboxNetworkPolicy = "deny-all";

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

  /** The Box `BoxConfig` passed to `Box.create` / `Box.fromSnapshot` — the user's config verbatim,
   * defaulting `keepAlive` on and enforcing the secure deny-all egress default at creation. */
  private boxConfig(): BoxConfig {
    return {
      ...this.config,
      keepAlive: this.config.keepAlive ?? true,
      // Lock egress down atomically at creation; callers open it per-session via `use({ networkPolicy })`.
      networkPolicy: toBoxNetworkPolicy(DEFAULT_NETWORK_POLICY),
    };
  }

  async create(
    input: SandboxBackendCreateInput,
  ): Promise<SandboxBackendHandle<UpstashSandboxOptions>> {
    const snapshotId = input.templateKey ? this.templates.get(input.templateKey) : undefined;
    const box = snapshotId
      ? await Box.fromSnapshot(snapshotId, this.boxConfig())
      : await Box.create(this.boxConfig());

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
      // The box starts with the secure deny-all default (set in `boxConfig`); `bootstrap`'s
      // `use({ networkPolicy })` opens egress when the build genuinely needs it (e.g. installing pkgs).
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
