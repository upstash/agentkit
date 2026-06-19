/**
 * Integration with **Eve's code-execution sandbox** (`eve/sandbox` — see
 * https://eve.dev/docs/sandbox). Eve's `defineSandbox({ backend, bootstrap, onSession })` runs an
 * agent's commands/files in an isolated backend (vercel / docker / microsandbox / …); a session
 * exposes `run`, `spawn`, `readTextFile`, `writeTextFile`, and `setNetworkPolicy`.
 *
 * This adapter does NOT bundle a sandbox runtime — it never imports `eve`. Instead it provides
 * structural types matching Eve's sandbox surface plus helpers that weave AgentKit in: every
 * `session.run(...)` can be traced via {@link Telemetry} and memoized via {@link ToolCache}. Pass the
 * instrumented config to Eve's real `defineSandbox`.
 *
 * (The generic tool-execution harness used to live in the core SDK; per design it now lives here,
 * aligned with Eve's sandbox model. A Vercel AI SDK sandbox integration may follow once AI SDK v7
 * ships.)
 */
import { stableHash, type Telemetry, type ToolCache } from "@upstash/agentkit-sdk";

/** Result of running a command in an Eve sandbox session. */
export interface EveSandboxRunResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  [key: string]: unknown;
}

/** Structural shape of an Eve sandbox session (the object returned by `use()`). */
export interface EveSandboxSession {
  run(opts: { command: string; [key: string]: unknown }): Promise<EveSandboxRunResult>;
  spawn?(opts: unknown): Promise<unknown>;
  readTextFile?(opts: { path: string }): Promise<string>;
  writeTextFile?(opts: { path: string; content: string }): Promise<void>;
  setNetworkPolicy?(policy: string): void | Promise<void>;
  [key: string]: unknown;
}

/** The `use()` callback Eve hands to `bootstrap`/`onSession` to obtain a session. */
export type EveSandboxUse = (opts?: unknown) => Promise<EveSandboxSession>;

/** Structural shape of the config object accepted by Eve's `defineSandbox`. */
export interface DefineSandboxConfig {
  backend?: unknown;
  revalidationKey?: () => string;
  bootstrap?: (args: { use: EveSandboxUse }) => Promise<void> | void;
  onSession?: (args: { use: EveSandboxUse; ctx?: unknown }) => Promise<void> | void;
  [key: string]: unknown;
}

export interface SandboxInstrumentation {
  /** Record a span per `run`. */
  telemetry?: Telemetry;
  /** Memoize deterministic command results (keyed by command + options). */
  toolCache?: ToolCache;
  /** Trace id to attach `run` spans to. */
  traceId?: string;
}

/**
 * Wrap a single Eve sandbox {@link EveSandboxSession} so each `run` is traced (Telemetry) and/or
 * memoized (ToolCache). Other operations (`spawn`, file IO, network policy) are delegated unchanged.
 */
export function instrumentSandboxSession(
  session: EveSandboxSession,
  instrumentation: SandboxInstrumentation,
): EveSandboxSession {
  const { telemetry, toolCache, traceId } = instrumentation;

  const baseRun = (opts: { command: string; [key: string]: unknown }) => session.run(opts);
  const cachedRun: (opts: {
    command: string;
    [key: string]: unknown;
  }) => Promise<EveSandboxRunResult> = toolCache
    ? (opts) =>
        toolCache.wrap("eve.sandbox.run", (key: unknown) => baseRun(key as typeof opts))(opts)
    : baseRun;

  const wrapped: EveSandboxSession = {
    run: (opts) => {
      if (!telemetry) return cachedRun(opts);
      return telemetry.trace("sandbox.run", () => cachedRun(opts), {
        type: "tool",
        ...(traceId !== undefined ? { traceId } : {}),
        attributes: { command: opts.command, commandHash: stableHash(opts) },
      });
    },
  };

  // Delegate the remaining session operations when present.
  if (session.spawn) wrapped.spawn = (opts) => session.spawn!(opts);
  if (session.readTextFile) wrapped.readTextFile = (opts) => session.readTextFile!(opts);
  if (session.writeTextFile) wrapped.writeTextFile = (opts) => session.writeTextFile!(opts);
  if (session.setNetworkPolicy) wrapped.setNetworkPolicy = (p) => session.setNetworkPolicy!(p);
  return wrapped;
}

/**
 * Wrap an Eve `defineSandbox` config so every session obtained via `use()` (in `bootstrap` and
 * `onSession`) is automatically instrumented with AgentKit telemetry/caching. Pass the result to
 * Eve's real `defineSandbox`.
 *
 * ```ts
 * import { defineSandbox } from "eve/sandbox";
 * import { withSandboxInstrumentation } from "@upstash/agentkit-eve";
 *
 * export default defineSandbox(
 *   withSandboxInstrumentation(
 *     { async onSession({ use }) { const s = await use(); await s.run({ command: "npm test" }); } },
 *     { telemetry, toolCache },
 *   ),
 * );
 * ```
 */
export function withSandboxInstrumentation(
  config: DefineSandboxConfig,
  instrumentation: SandboxInstrumentation,
): DefineSandboxConfig {
  const wrapUse =
    (use: EveSandboxUse): EveSandboxUse =>
    async (opts?: unknown) =>
      instrumentSandboxSession(await use(opts), instrumentation);

  return {
    ...config,
    ...(config.bootstrap
      ? { bootstrap: (args) => config.bootstrap!({ ...args, use: wrapUse(args.use) }) }
      : {}),
    ...(config.onSession
      ? { onSession: (args) => config.onSession!({ ...args, use: wrapUse(args.use) }) }
      : {}),
  };
}
