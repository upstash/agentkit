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
 * in `bootstrap`'s `use(...)` or the session `use(...)` to open it. Note also that `config.env` is
 * injected into the box and is therefore readable by code running inside it — don't pass secrets you
 * wouldn't want model-generated code to see.
 *
 * The lifecycle maps onto Box like this: `prewarm` builds a template box (seed files + your `bootstrap`
 * hook), captures a Box **snapshot**, and records `templateKey → snapshotId` in a **durable Redis
 * registry**; `create` opens a live session from that snapshot with `Box.fromSnapshot` (or a fresh
 * `Box.create` when there's no template). The registry is what lets `create` (running per request) reuse
 * the snapshot built by `prewarm` (running at build/startup) — a plain in-memory map can't bridge those
 * processes, and Box has no static snapshot lookup. When a sandbox has nothing to bake (no seed files,
 * no `bootstrap`), `prewarm` builds **no** box at all and `create` just spins a fresh one.
 *
 * **Session reuse:** Eve re-opens a session many times (per turn / retry / re-render) and hands the box
 * id we returned in `captureState` back as `create`'s `existingMetadata`. `create` **reattaches** to that
 * box (`Box.get`) instead of making a new one, and `dispose` is a **no-op** — so a conversation keeps a
 * single box rather than piling up one per open. Boxes default to Box's pause-based idle lifecycle
 * (`keepAlive: false`): idle → auto-paused, reattach → resumed, then reaped by Box. (`keepAlive: true`
 * opts into an always-running box you manage yourself.)
 *
 * Eve roots its sandbox tools at `/workspace`, but a Box session lives in `/workspace/home`; this backend
 * bridges the two (in `resolvePath` and in raw commands), so the agent's file ops and `find`/`grep`
 * commands hit the right directory.
 *
 * `@upstash/box` is an optional peer dependency — only needed when you import this entry point. This
 * backend is type-checked against Eve's real types but cannot be runtime-verified in this repo.
 */
import { Box } from "@upstash/box";
import type { BoxConfig, NetworkPolicy as BoxNetworkPolicy } from "@upstash/box";
import { Redis } from "@upstash/redis";
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
 *
 * Two AgentKit-only fields sit alongside the Box config: `redis` and `templatePrefix`, which back the
 * durable template→snapshot registry (so a snapshot built by `prewarm` at build time is reused by
 * `create` per request — see {@link UpstashSandboxBackend}). They are stripped before the rest is
 * handed to `Box.create`.
 */
export type UpstashBackendConfig = Omit<BoxConfig, "networkPolicy"> & {
  /**
   * Redis client backing the template→snapshot registry. `prewarm` and `create` run in different
   * processes (build/startup vs. per request), so the snapshot id must be stored durably to be reused
   * — an in-memory map would orphan the prewarmed box. Defaults to `Redis.fromEnv()`; only touched when
   * a sandbox has a template (seed files or a `bootstrap`).
   */
  redis?: Redis;
  /** Key prefix for the template registry. Defaults to `agentkit:sandbox:template`. */
  templatePrefix?: string;
  /**
   * A **base Box snapshot** every fresh session restores from, instead of a bare `Box.create`. Use it
   * to bake heavy, slow-changing setup (browser binaries, ffmpeg, a preinstalled toolchain) into one
   * snapshot out-of-band — e.g. built once at server startup from Next.js `instrumentation.ts` — and
   * have every session start from it.
   *
   * This is orthogonal to Eve's `bootstrap`/prewarm template mechanism: `bootstrap` bakes a template
   * from *this repo's* seed files + hook and Eve decides when to rebuild it; `baseSnapshot` points at a
   * snapshot **you** manage and address by id, which Box has no static name lookup for — hence a
   * resolver so you can look the id up from your own store (Redis keyed by a name) at open time.
   *
   * Pass a snapshot id string, or a function resolving one (sync or async). Returning `undefined` (or
   * a snapshot that no longer exists) falls back to a fresh `Box.create`. When both a prewarmed
   * template snapshot and a `baseSnapshot` apply, the template snapshot wins (it's the more specific,
   * repo-derived one); `baseSnapshot` is the fallback for sessions with no template.
   */
  baseSnapshot?: string | (() => string | undefined | Promise<string | undefined>);
};

/** Eve's canonical sandbox root (hardcoded in its glob/grep/file tools). */
const EVE_ROOT = "/workspace";
/** Upstash Box's actual working directory — every session starts here; `/workspace` itself is off-limits. */
const BOX_ROOT = "/workspace/home";

/**
 * Bridge an Eve-rooted path to its Box location: Eve assumes `/workspace`, Box uses `/workspace/home`.
 * Relative paths anchor under the box root; `/workspace[/…]` is remapped; already-Box-rooted and other
 * absolute paths (`/tmp`, `/etc`) pass through untouched.
 */
export function toBoxPath(path: string): string {
  if (!path.startsWith("/")) return `${BOX_ROOT}/${path}`;
  if (path === EVE_ROOT || path === `${EVE_ROOT}/`) return BOX_ROOT;
  if (path.startsWith(`${EVE_ROOT}/`)) {
    const rest = path.slice(EVE_ROOT.length + 1);
    return rest === "home" || rest.startsWith("home/") ? path : `${BOX_ROOT}/${rest}`;
  }
  return path;
}

/**
 * Remap `/workspace` → `/workspace/home` inside a raw command string. Eve's built-in glob/grep tools
 * run commands like `find /workspace …` with the literal Eve root (they don't go through `resolvePath`),
 * so the box would search the wrong (off-limits) directory.
 *
 * Only rewrites `/workspace` when it **starts a path token**: the lookbehind skips it when preceded by a
 * word char, `.`, or `/` — i.e. inside a URL (`https://host/workspace/x`) or a relative path
 * (`./workspace`) — and the lookahead leaves `/workspace/home…` (already box-rooted) and words like
 * `/workspaces` alone. This still can't reach `/workspace` paths baked **inside files** the model writes
 * (only the command text is rewritten); the model normally avoids that because tool output shows it the
 * real `/workspace/home` paths.
 */
export function rewriteWorkspacePaths(command: string): string {
  return command.replace(/(?<![\w./])\/workspace(?!\/home)(?=$|[^\w])/g, BOX_ROOT);
}

/**
 * Secure default: deny all network egress unless the caller opts in via `networkPolicy` (on the
 * backend, the bootstrap `use(...)`, or the session `use(...)`). An agent sandbox runs untrusted,
 * model-generated code, so open egress would mean SSRF / data exfiltration / reaching your own
 * infrastructure from inside the box by default.
 */
const DEFAULT_NETWORK_POLICY: SandboxNetworkPolicy = "deny-all";

/**
 * Map Eve's (Vercel-shaped) network policy onto Box's. Box's policy is a plain domain/CIDR allow-list,
 * so it can't honor Eve's per-domain firewall rules: `transform` (inject headers at the firewall to
 * broker credentials so secrets never enter the box) or `forwardURL`. Silently dropping those would send
 * the request unauthenticated, or push the model to embed the secret inside the box, so we **throw**
 * rather than quietly downgrade a security control. (Plain allow-lists and empty rule arrays map fine.)
 *
 * For credential brokering on Box, set `attachHeaders` at backend creation instead:
 * `upstash({ attachHeaders: { "api.example.com": { Authorization: "Bearer ..." } } })`.
 */
export function toBoxNetworkPolicy(policy: SandboxNetworkPolicy): BoxNetworkPolicy {
  if (policy === "allow-all") return { mode: "allow-all" };
  if (policy === "deny-all") return { mode: "deny-all" };
  const allow = policy.allow;
  let allowedDomains: string[] | undefined;
  if (Array.isArray(allow)) {
    allowedDomains = allow;
  } else if (allow) {
    for (const [domain, rules] of Object.entries(allow)) {
      if (
        Array.isArray(rules) &&
        rules.some((r) => r && (r.transform || r.forwardURL || r.match))
      ) {
        throw new Error(
          `UpstashSandboxBackend: the Upstash Box backend can't honor per-domain network rules ` +
            `(transform / forwardURL / match) for "${domain}"; its network policy is a plain ` +
            `domain/CIDR allow-list. To inject credentials into outbound requests, set Box's ` +
            `attachHeaders at backend creation: upstash({ attachHeaders: { "${domain}": { ... } } }).`,
        );
      }
    }
    allowedDomains = Object.keys(allow);
  }
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
  // Bridge Eve's `/workspace` paths in the command itself to Box's `/workspace/home`.
  let cmd = rewriteWorkspacePaths(options.command);
  if (options.env && Object.keys(options.env).length) {
    const env = Object.entries(options.env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    cmd = `${env} ${cmd}`;
  }
  // Default cwd is Box's `/workspace/home`; only emit a `cd` when a working directory is requested.
  if (options.workingDirectory)
    cmd = `cd ${shellQuote(toBoxPath(options.workingDirectory))} && ${cmd}`;
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
  // Eve hands us `/workspace`-rooted (or relative) paths; map them to Box's `/workspace/home`.
  const resolvePath = (path: string): string => toBoxPath(path);

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
  /** In-process fast-path cache over the durable Redis registry (templateKey → Box snapshot id). */
  private readonly templates = new Map<string, string>();
  private redisClient?: Redis;

  constructor(config: UpstashBackendConfig = {}) {
    this.config = config;
    this.name = config.name ?? "upstash";
  }

  /** Lazily resolve the Redis client backing the template registry (so envless setups that never use a
   * template don't trip `Redis.fromEnv()`). */
  private redis(): Redis {
    return (this.redisClient ??= this.config.redis ?? Redis.fromEnv());
  }

  /** Registry key for a template's snapshot id, namespaced by backend name. */
  private templateRegistryKey(templateKey: string): string {
    const prefix = this.config.templatePrefix ?? "agentkit:sandbox:template";
    return `${prefix}:${this.name}:${templateKey}`;
  }

  /** Snapshot id for a template — in-process cache first, then the durable Redis registry. */
  private async resolveSnapshot(templateKey: string): Promise<string | undefined> {
    const cached = this.templates.get(templateKey);
    if (cached) return cached;
    const stored = await this.redis().get<string>(this.templateRegistryKey(templateKey));
    if (stored) this.templates.set(templateKey, stored);
    return stored ?? undefined;
  }

  /** The Box `BoxConfig` passed to `Box.create` / `Box.fromSnapshot` — the user's config verbatim
   * (minus the AgentKit-only `redis`/`templatePrefix`/`baseSnapshot`), defaulting `keepAlive` on and
   * enforcing the secure deny-all egress default at creation. */
  private boxConfig(): BoxConfig {
    const {
      redis: _redis,
      templatePrefix: _templatePrefix,
      baseSnapshot: _baseSnapshot,
      ...box
    } = this.config;
    return {
      ...box,
      // Default to Box's pause-based idle lifecycle: the box auto-pauses when idle (cheap), resumes on
      // reattach, and is reaped after its TTL — so sessions are reused, not leaked. `keepAlive: true`
      // opts into an always-running box (which can't be paused) that you manage yourself.
      keepAlive: box.keepAlive ?? false,
      // Lock egress down atomically at creation; callers open it per-session via `use({ networkPolicy })`.
      networkPolicy: toBoxNetworkPolicy(DEFAULT_NETWORK_POLICY),
    };
  }

  /** Resolve the configured base snapshot id (string or resolver), or undefined when none/unresolved. */
  private async resolveBaseSnapshot(): Promise<string | undefined> {
    const base = this.config.baseSnapshot;
    if (!base) return undefined;
    return (typeof base === "function" ? await base() : base) ?? undefined;
  }

  /** A fresh box: from the configured `baseSnapshot` when one resolves (falling back to a bare create if
   * that snapshot is gone), otherwise a bare `Box.create`. Shared by `openBox`'s fresh path and `prewarm`
   * so a template is layered on top of the same base. */
  private async createBaseBox(): Promise<Box> {
    const baseId = await this.resolveBaseSnapshot();
    if (baseId) {
      try {
        return await Box.fromSnapshot(baseId, this.boxConfig());
      } catch {
        // The base snapshot was deleted/expired — degrade to a bare box rather than failing the session.
      }
    }
    return Box.create(this.boxConfig());
  }

  /** Connection-only options for `Box.get` (it retrieves an existing box; it doesn't take create config). */
  private connOptions(): { apiKey?: string; baseUrl?: string } {
    const { apiKey, baseUrl } = this.config;
    return {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    };
  }

  /**
   * Open the Box for a session, in priority order:
   *  1. **Reattach** to the box from a previous open of this session (Eve hands our captured `boxId`
   *     back as `existingMetadata`) — this is what stops every open from spinning a fresh box.
   *  2. Restore the prewarmed **template snapshot** (from the Redis registry).
   *  3. Create a **fresh** box from the base runtime.
   */
  private async openBox(input: SandboxBackendCreateInput): Promise<Box> {
    const existingBoxId = (input.existingMetadata as { boxId?: string } | undefined)?.boxId;
    if (existingBoxId) {
      try {
        const box = await Box.get(existingBoxId, this.connOptions());
        // Re-assert the secure default; each opened session starts deny-all (use(...) re-opens egress).
        await box.updateNetworkPolicy(toBoxNetworkPolicy(DEFAULT_NETWORK_POLICY)).catch(() => {});
        return box;
      } catch {
        // The box was deleted/expired since we captured it — fall through to template/fresh.
      }
    }

    const snapshotId = input.templateKey
      ? await this.resolveSnapshot(input.templateKey)
      : undefined;
    if (snapshotId) {
      try {
        return await Box.fromSnapshot(snapshotId, this.boxConfig());
      } catch {
        // The snapshot was deleted out from under the registry — drop the stale entry and start fresh.
        this.templates.delete(input.templateKey as string);
        await this.redis()
          .del(this.templateRegistryKey(input.templateKey as string))
          .catch(() => {});
      }
    }
    return this.createBaseBox();
  }

  async create(
    input: SandboxBackendCreateInput,
  ): Promise<SandboxBackendHandle<UpstashSandboxOptions>> {
    const box = await this.openBox(input);

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

    // Don't tear the box down here: Eve calls `dispose` at the end of every session-open, and the next
    // open reattaches to this same box via `existingMetadata` (see `openBox`). Deleting/pausing it would
    // force a fresh box each turn (the "N boxes per turn" bug; keep-alive boxes can't even be paused).
    // A non-keep-alive box auto-pauses when idle and is reaped by Box's lifecycle, so this is a no-op —
    // matching Eve's own Vercel backend.
    const dispose = async (): Promise<void> => {};

    return { session, useSessionFn, captureState, dispose };
  }

  async prewarm(
    input: SandboxBackendPrewarmInput<UpstashSandboxOptions>,
  ): Promise<{ reused: boolean }> {
    // Nothing to bake into a template → don't build a throwaway box; `create` spins a fresh box per
    // session. (Avoids the "two boxes, first unused" case for sandboxes with no seed files/bootstrap.)
    if (input.seedFiles.length === 0 && !input.bootstrap) return { reused: false };

    // Already provisioned (durably, in Redis) → reuse; this is what lets `create` (a different process)
    // find the snapshot. The in-memory map is only a same-process fast path.
    const existing = await this.resolveSnapshot(input.templateKey);
    if (existing) return { reused: true };

    // Layer this repo's template (seed files + bootstrap) on top of the base snapshot, so a prewarmed
    // template inherits whatever the base bakes in.
    const box = await this.createBaseBox();
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
      // Persist durably so `create` (running in another process) can restore from it.
      await this.redis().set(this.templateRegistryKey(input.templateKey), snapshot.id);
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
