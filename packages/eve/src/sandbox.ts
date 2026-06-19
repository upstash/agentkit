/**
 * Sandbox backend for **Eve** (`eve/sandbox`, https://eve.dev/docs/sandbox), powered by
 * **Upstash Box** (`@upstash/box`) — a serverless cloud sandbox for AI agents.
 *
 * `upstash()` is a drop-in replacement for Eve's `vercel()` backend. Take any Eve sandbox file and
 * swap the backend import:
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
 * `@upstash/box` is an optional peer dependency — only needed when you import this entry point.
 */
import { Box } from "@upstash/box";
import type { BoxSize, NetworkPolicy, Runtime } from "@upstash/box";

/** Result of running a command in a sandbox session. */
export interface EveSandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  [key: string]: unknown;
}

/** A network policy: an Eve-style shorthand string or a full Box {@link NetworkPolicy}. */
export type SandboxNetworkPolicy = "allow-all" | "deny-all" | NetworkPolicy;

/** A live sandbox session, backed by an Upstash Box. */
export interface EveSandboxSession {
  run(opts: { command: string; [key: string]: unknown }): Promise<EveSandboxRunResult>;
  readTextFile(opts: { path: string }): Promise<string>;
  writeTextFile(opts: { path: string; content: string }): Promise<void>;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
  /** A public URL for a port exposed inside the sandbox. */
  getPublicURL(port: number): Promise<string>;
  /** Pause the sandbox (keep-alive boxes can resume later). */
  stop(): Promise<void>;
  /** Destroy the sandbox and free its resources. */
  destroy(): Promise<void>;
  readonly id: string;
  readonly cwd: string;
  /** Escape hatch to the underlying Box for advanced operations (git, agents, files, …). */
  readonly box: Box;
}

/** A sandbox backend Eve's `defineSandbox` can drive (the slot `vercel()` / `upstash()` fill). */
export interface SandboxBackend {
  readonly providerId: string;
  createSession(options?: {
    sessionId?: string;
    networkPolicy?: SandboxNetworkPolicy;
  }): Promise<EveSandboxSession>;
}

export interface UpstashBackendConfig {
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

function toBoxNetworkPolicy(policy: SandboxNetworkPolicy): NetworkPolicy {
  return typeof policy === "string" ? { mode: policy } : policy;
}

function resolvePath(box: Box, path: string): string {
  return path.startsWith("/") ? path : `${box.cwd.replace(/\/$/, "")}/${path}`;
}

/** Wrap a live Box as an {@link EveSandboxSession}. */
function boxSession(box: Box): EveSandboxSession {
  return {
    get id() {
      return box.id;
    },
    get cwd() {
      return box.cwd;
    },
    box,
    async run({ command }) {
      const run = await box.exec.command(command);
      const exitCode = run.exitCode ?? 0;
      const output = run.result ?? "";
      return { stdout: output, stderr: exitCode === 0 ? "" : output, exitCode };
    },
    async readTextFile({ path }) {
      return box.files.read(resolvePath(box, path));
    },
    async writeTextFile({ path, content }) {
      await box.files.write({ path: resolvePath(box, path), content });
    },
    async setNetworkPolicy(policy) {
      await box.updateNetworkPolicy(toBoxNetworkPolicy(policy));
    },
    async getPublicURL(port) {
      const { url } = await box.getPublicURL(port);
      return url;
    },
    async stop() {
      await box.pause();
    },
    async destroy() {
      await box.delete();
    },
  };
}

/**
 * An Upstash Box backend for Eve's `defineSandbox`. Drop-in replacement for `vercel()` / `docker()`.
 */
export function upstash(config: UpstashBackendConfig = {}): SandboxBackend {
  return {
    providerId: "upstash-box",
    async createSession(options = {}) {
      const box = await Box.create({
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        runtime: toBoxRuntime(config.runtime),
        size: toBoxSize(config),
        keepAlive: config.keepAlive ?? true,
        ...(config.initCommand !== undefined ? { initCommand: config.initCommand } : {}),
        ...(config.env !== undefined ? { env: config.env } : {}),
        ...(options.sessionId !== undefined ? { name: options.sessionId } : {}),
      });
      const policy = options.networkPolicy ?? config.networkPolicy;
      if (policy) await box.updateNetworkPolicy(toBoxNetworkPolicy(policy));
      return boxSession(box);
    },
  };
}
