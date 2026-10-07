/**
 * Sandbox provider for **Eve** (`eve/sandbox`, https://eve.dev/docs/sandbox), powered by
 * **Upstash Box** (`@upstash/box`) — a serverless cloud sandbox for AI agents.
 *
 * `UpstashSandbox` is an Eve sandbox **provider** (eve ≥0.64's `defineSandboxProvider()` contract),
 * used exactly like eve's built-in `VercelSandbox`:
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox } from "eve/sandbox";
 * import { UpstashSandbox } from "@upstash/agentkit-eve/sandbox";
 *
 * export const environment = UpstashSandbox.environment({
 *   runtime: "node",
 *   size: "medium",
 *   // Runs once per environment generation (at `eve build`), not per session; the result is
 *   // captured as a Box snapshot every session starts from.
 *   async prepare(sandbox) {
 *     await sandbox.setNetworkPolicy("allow-all"); // egress is denied by default
 *     const r = await sandbox.run({ command: "sudo apt-get update && sudo apt-get install -y jq" });
 *     if (r.exitCode !== 0) throw new Error(r.stderr);
 *   },
 * });
 *
 * export default defineSandbox(() => environment.open()); // sessions stay deny-all
 * ```
 *
 * **Lifecycle** (eve owns the orchestration; this provider maps each phase onto Box):
 *
 * - `prepare` (at `eve build`, or first sandbox access under `eve dev`) — creates a temporary box,
 *   writes eve's compiled workspace seeds (`/workspace`) and skills (`$HOME/.agents/skills`), runs
 *   your `prepare` hook, captures a Box **snapshot** and deletes the temporary box. The snapshot id
 *   is the prepared artifact; eve persists it in the build output, so no external registry is
 *   needed. With nothing to bake (no seeds, skills or hook) no box is created at all.
 * - `start` (once per durable eve session) — restores a box from that snapshot (or from
 *   `baseSnapshot`, or a fresh `Box.create`), applies `open({ networkPolicy })`, and returns
 *   `{ boxId }` as the session state eve checkpoints.
 * - `resume` (later workflow steps, restarts, redeploys) — reattaches with `Box.get(boxId)`. Per
 *   eve's contract it **fails** when the box is gone instead of silently creating a fresh one (that
 *   would drop the session's files); `sandbox.delete()` is how a session asks for a fresh box.
 * - `sandbox.stop()` → Box `pause` (compute released, state kept; the next access auto-resumes);
 *   server shutdown → `pause`, failures tolerated; `sandbox.delete()` → Box `delete`. The prepared
 *   snapshot is never touched by a session — it is shared by every session of the environment.
 *
 * **Network egress is denied by default** (see {@link DEFAULT_NETWORK_POLICY}); open it per session
 * with `environment.open({ networkPolicy })` or `sandbox.setNetworkPolicy(...)`. Box applies the
 * policy to the box itself, so it survives pause/resume. `env` in the environment options is injected
 * into the box and is readable by code running there — don't pass secrets you wouldn't want
 * model-generated code to see (use `attachHeaders` to broker credentials instead).
 *
 * Eve roots its sandbox tools at `/workspace`, but a Box session lives in `/workspace/home`; this
 * provider bridges the two (in `resolvePath` and in raw commands), so the agent's file ops and
 * `find`/`grep` commands hit the right directory.
 *
 * `@upstash/box` (≥0.7.1) is an optional peer dependency — only needed when you import this entry
 * point. Credentials come from `apiKey` or the `UPSTASH_BOX_API_KEY` env var, at build time (for
 * `prepare`) and at run time.
 */
import { createHash, randomBytes } from "node:crypto";
import { Box } from "@upstash/box";
import type { BoxConfig, NetworkPolicy as BoxNetworkPolicy } from "@upstash/box";
import type {
  MutableNetworkSandboxSession,
  SandboxNetworkPolicy,
  SandboxProcess,
} from "eve/sandbox";
import { defineSandboxProvider } from "eve/sandbox/provider";
import type {
  SandboxDeleteOptions,
  SandboxProviderHandle,
  SandboxProviderResources,
} from "eve/sandbox/provider";

/** Options for `environment.open(...)` — applied once, when eve starts the session's box. */
export interface UpstashSandboxOpenOptions {
  /** Network policy for the session's box. Defaults to deny-all. */
  readonly networkPolicy?: SandboxNetworkPolicy;
}

/**
 * Options for `UpstashSandbox.environment(...)` — the **Upstash Box** `BoxConfig` as-is (`runtime`,
 * `size`, `apiKey`/`baseUrl`, `keepAlive`, `initCommand`, `env`, `git`, `skills`, `mcpServers`,
 * `attachHeaders`, `timeout`, …), plus two AgentKit fields: `prepare` and `baseSnapshot`.
 *
 * Omitted from `BoxConfig`: `networkPolicy` (egress is deny-all at creation and opened per session —
 * see {@link UpstashSandboxOpenOptions}) and `name` (box names are unique per account, and every
 * session gets its own box; the provider names them `eve-<session hash>-<random>`).
 *
 * Eve hashes these options into the environment's configuration, so changing any of them (including
 * the source of `prepare`) starts a new environment generation for new sessions. Prefer
 * `UPSTASH_BOX_API_KEY` over an inline `apiKey` so rotating the key doesn't do that.
 */
export type UpstashSandboxEnvironmentOptions = Omit<BoxConfig, "networkPolicy" | "name"> & {
  /**
   * Setup every session's box inherits — installing packages, cloning a repo, warming caches. Runs
   * once per environment generation inside a temporary box (after workspace seeds and skills are
   * written); the result is captured as a Box snapshot. The box starts deny-all: call
   * `sandbox.setNetworkPolicy("allow-all")` (or an allow-list) first if the setup needs egress.
   * Sessions do **not** inherit the policy you set here.
   */
  prepare?: (sandbox: MutableNetworkSandboxSession) => Promise<void> | void;
  /**
   * A **base Box snapshot** to build on instead of a bare `Box.create` — for heavy, slow-changing
   * setup (browser binaries, a toolchain) you bake and manage yourself, out of band. `prepare` layers
   * on top of it; with nothing to prepare, sessions restore from it directly.
   *
   * A snapshot id, or a resolver (sync or async) — e.g. looking the id up in your own store.
   * `undefined` means no base. The resolver runs when eve prepares the environment and, when there
   * is nothing to prepare, again whenever a session starts.
   */
  baseSnapshot?: string | (() => string | undefined | Promise<string | undefined>);
};

/** The prepared artifact eve persists in the build output. `null` = nothing was baked. */
type UpstashSandboxArtifact = { readonly snapshotId: string | null };

/** The minimal state eve checkpoints for a durable session: the box it owns. */
type UpstashSandboxState = { readonly boxId: string; readonly version: 1 };

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
 * Secure default: deny all network egress unless the session opts in. An agent sandbox runs untrusted,
 * model-generated code, so open egress would mean SSRF / data exfiltration / reaching your own
 * infrastructure from inside the box by default.
 */
const DEFAULT_NETWORK_POLICY: SandboxNetworkPolicy = "deny-all";

/**
 * Map Eve's (Vercel-shaped) network policy onto Box's. Box's policy is a plain domain/CIDR allow-list,
 * so it can't honor Eve's per-domain firewall rules: `transform` (inject headers at the firewall to
 * broker credentials so secrets never enter the box), `forwardURL` or `match`. Silently dropping those
 * would send the request unauthenticated, or push the model to embed the secret inside the box, so we
 * **throw** rather than quietly downgrade a security control. (Plain allow-lists and empty rule arrays
 * map fine.)
 *
 * For credential brokering on Box, set `attachHeaders` in the environment options instead:
 * `UpstashSandbox.environment({ attachHeaders: { "api.example.com": { Authorization: "Bearer ..." } } })`.
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
          `UpstashSandbox: Upstash Box can't honor per-domain network rules ` +
            `(transform / forwardURL / match) for "${domain}"; its network policy is a plain ` +
            `domain/CIDR allow-list. To inject credentials into outbound requests, set Box's ` +
            `attachHeaders in the environment options: ` +
            `UpstashSandbox.environment({ attachHeaders: { "${domain}": { ... } } }).`,
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

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await streamToBytes(stream));
}

/** A writable byte stream plus its controller, closed exactly once. */
function pushStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (d: Uint8Array) => void;
  end: (err?: unknown) => void;
} {
  let controller!: { enqueue(c: Uint8Array): void; close(): void; error(e: unknown): void };
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (d) => {
      if (!done) controller.enqueue(new Uint8Array(d));
    },
    end: (err) => {
      if (done) return;
      done = true;
      if (err === undefined) controller.close();
      else controller.error(err);
    },
  };
}

interface ProcessOptions {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/**
 * Start a process with Box's `exec.session` (a live WebSocket session: streamed stdout/stderr and
 * signals). The abort signal eve binds to every sandbox call (turn cancellation) kills the process
 * tree, so a cancelled turn doesn't leave a runaway command in the box.
 */
async function spawnOnBox(box: Box, options: ProcessOptions): Promise<SandboxProcess> {
  options.abortSignal?.throwIfAborted();
  const stdout = pushStream();
  const stderr = pushStream();
  const handle = await box.exec.session({
    cmd: rewriteWorkspacePaths(options.command),
    cwd: options.workingDirectory ? toBoxPath(options.workingDirectory) : BOX_ROOT,
    ...(options.env && Object.keys(options.env).length
      ? { env: Object.entries(options.env).map(([k, v]) => `${k}=${v}`) }
      : {}),
    onStdout: stdout.push,
    onStderr: stderr.push,
  });
  const onAbort = () => handle.kill("KILL");
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const exited = handle.wait().then(
    (exitCode) => {
      options.abortSignal?.removeEventListener("abort", onAbort);
      stdout.end();
      stderr.end();
      return { exitCode };
    },
    (err: unknown) => {
      options.abortSignal?.removeEventListener("abort", onAbort);
      stdout.end(err);
      stderr.end(err);
      throw err;
    },
  );
  // Keep an unobserved wait() rejection from surfacing as an unhandled rejection; callers that
  // await wait() still see it.
  exited.catch(() => {});
  return {
    pid: handle.pid,
    stdout: stdout.stream,
    stderr: stderr.stream,
    wait: () => exited,
    kill: async () => {
      handle.kill("KILL");
    },
  };
}

/** Build Eve's {@link MutableNetworkSandboxSession} over a live Box. */
function buildSession(box: Box): MutableNetworkSandboxSession {
  // Eve hands us `/workspace`-rooted (or relative) paths; map them to Box's `/workspace/home`.
  const resolvePath = (path: string): string => toBoxPath(path);

  return {
    resolvePath,
    spawn: (options) => spawnOnBox(box, options),
    async run(options) {
      const proc = await spawnOnBox(box, options);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
        proc.wait(),
      ]);
      options.abortSignal?.throwIfAborted();
      return { exitCode, stdout, stderr };
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
      const run = await box.exec.command(
        `rm ${flags ? `-${flags}` : ""} ${shellQuote(resolvePath(path))}`.trim(),
      );
      if ((run.exitCode ?? 0) !== 0) {
        throw new Error(`UpstashSandbox: removing "${path}" failed: ${run.stderr || run.result}`);
      }
    },
  };
}

/**
 * Eve's compiled workspace seeds and skills, flattened to absolute target paths (workspace files land
 * under `/workspace`, skills under `$HOME/.agents/skills`).
 */
function resourceFiles(
  resources: SandboxProviderResources,
): { path: string; content: string | Uint8Array }[] {
  return [resources.workspace, resources.skills].flatMap((tree) =>
    tree === undefined
      ? []
      : tree.files.map((f) => ({
          path: `${tree.targetPath}/${f.relativePath}`,
          content: f.content,
        })),
  );
}

/** Write eve's resources into a box, expanding `$HOME` and bridging `/workspace` → `/workspace/home`. */
async function writeResources(
  box: Box,
  files: { path: string; content: string | Uint8Array }[],
): Promise<void> {
  let home: string | undefined;
  for (const file of files) {
    let path = file.path;
    if (path.startsWith("$HOME/")) {
      home ??= (await box.exec.command('printf %s "$HOME"')).stdout.trim();
      if (!home) throw new Error("UpstashSandbox: could not resolve $HOME inside the box.");
      path = `${home}/${path.slice("$HOME/".length)}`;
    }
    const binary = typeof file.content !== "string";
    await box.files.write({
      path: toBoxPath(path),
      content: binary ? toBase64(file.content) : (file.content as string),
      ...(binary ? { encoding: "base64" as const } : {}),
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireArtifact(artifact: unknown): UpstashSandboxArtifact {
  const a = artifact as Partial<UpstashSandboxArtifact> | null;
  if (!a || typeof a !== "object" || !(a.snapshotId === null || typeof a.snapshotId === "string")) {
    throw new Error(
      "UpstashSandbox: the prepared sandbox artifact is missing or malformed; rebuild (`eve build`) or redeploy.",
    );
  }
  return a as UpstashSandboxArtifact;
}

function requireState(state: unknown): UpstashSandboxState {
  const s = state as Partial<UpstashSandboxState> | null;
  if (!s || typeof s !== "object" || typeof s.boxId !== "string" || s.version !== 1) {
    throw new Error(
      "UpstashSandbox: unrecognized session state; delete the session's sandbox to start fresh.",
    );
  }
  return s as UpstashSandboxState;
}

/** Provider handle over a live box: the session plus eve's lifecycle hooks. */
function createHandle(box: Box): SandboxProviderHandle<MutableNetworkSandboxSession> {
  // Set once `onSessionDelete` destroyed the box: eve may still call stop/shutdown on the handle.
  let deleted = false;
  return {
    sandbox: buildSession(box),
    // `sandbox.stop()`: release compute, keep the box resumable (`resume` → `Box.get` auto-resumes).
    // Provider errors must reject — keep-alive boxes can't be paused and will.
    async onSessionStop() {
      if (deleted) return;
      await box.pause();
    },
    // Server stopping: nothing may be left running, but failures must not block teardown.
    async onRuntimeShutdown() {
      if (deleted) return;
      await box.pause().catch(() => {});
    },
    // `sandbox.delete()`: permanently remove the session's box. The prepared snapshot is shared by
    // every session of the environment and must survive. Errors reject so eve keeps the state and
    // authored code can retry.
    async onSessionDelete(options?: SandboxDeleteOptions) {
      if (deleted) return;
      options?.abortSignal?.throwIfAborted(); // Box's API takes no signal; honour it at the boundary
      await box.delete();
      deleted = true;
    },
  };
}

/**
 * The Upstash Box sandbox provider for Eve. Call `UpstashSandbox.environment(options)`, export the
 * result from your sandbox file as `environment`, and return `environment.open()` from
 * `defineSandbox()`.
 */
export const UpstashSandbox = defineSandboxProvider<
  UpstashSandboxEnvironmentOptions | undefined,
  UpstashSandboxOpenOptions | undefined,
  UpstashSandboxArtifact,
  UpstashSandboxState,
  MutableNetworkSandboxSession
>({
  name: "upstash",
  environment(options) {
    const { prepare: prepareHook, baseSnapshot, ...boxOptions } = options ?? {};

    /** `BoxConfig` for new boxes: the user's options, pause-based idle, deny-all egress, a name. */
    const boxConfig = (name: string): BoxConfig => ({
      ...boxOptions,
      name,
      // Pause-based idle by default: an idle box auto-pauses (cheap) and resumes on the next
      // command. `keepAlive: true` opts into an always-running box (which can't be paused).
      keepAlive: boxOptions.keepAlive ?? false,
      // Lock egress down atomically at creation; sessions open it via open()/setNetworkPolicy().
      networkPolicy: toBoxNetworkPolicy(DEFAULT_NETWORK_POLICY),
    });

    const connection = {
      ...(boxOptions.apiKey !== undefined ? { apiKey: boxOptions.apiKey } : {}),
      ...(boxOptions.baseUrl !== undefined ? { baseUrl: boxOptions.baseUrl } : {}),
    };

    const resolveBaseSnapshot = async (): Promise<string | undefined> => {
      if (!baseSnapshot) return undefined;
      return (
        (typeof baseSnapshot === "function" ? await baseSnapshot() : baseSnapshot) ?? undefined
      );
    };

    /** A new box restored from `snapshotId`, or a fresh one. A missing snapshot fails loudly. */
    const createBox = async (name: string, snapshotId: string | undefined): Promise<Box> => {
      if (!snapshotId) return Box.create(boxConfig(name));
      try {
        return await Box.fromSnapshot(snapshotId, boxConfig(name));
      } catch (err) {
        throw new Error(
          `UpstashSandbox: could not restore Upstash Box snapshot "${snapshotId}" (${errorMessage(err)}). ` +
            `If it was deleted, rebuild (\`eve build\`) or redeploy to prepare the environment again.`,
          { cause: err },
        );
      }
    };

    return {
      async prepare(ctx) {
        const files = resourceFiles(ctx.resources);
        // Nothing to bake → no temporary box, no snapshot; sessions start from the base (if any).
        if (files.length === 0 && !prepareHook) return { snapshotId: null };

        const box = await createBox(
          `eve-prep-${randomBytes(4).toString("hex")}`,
          await resolveBaseSnapshot(),
        );
        try {
          await writeResources(box, files);
          if (prepareHook) await prepareHook(buildSession(box));
          const snapshot = await box.snapshot({
            name: `eve-${ctx.sourceRevision}`.replace(/[^\w.-]/g, "-").slice(0, 120),
          });
          ctx.log?.(`Prepared Upstash Box snapshot ${snapshot.id}`);
          return { snapshotId: snapshot.id };
        } catch (err) {
          throw new Error(
            `UpstashSandbox: failed to prepare the sandbox environment: ${errorMessage(err)}`,
            {
              cause: err,
            },
          );
        } finally {
          // Snapshots outlive the box they were taken from.
          await box.delete().catch(() => {});
        }
      },

      async start(ctx, openOptions, artifact) {
        const { snapshotId } = requireArtifact(artifact);
        // Unique per start (box names are account-wide); the session hash makes boxes traceable
        // to their eve session in the Box console.
        const sessionTag = createHash("sha256").update(ctx.session.id).digest("hex").slice(0, 12);
        const box = await createBox(
          `eve-${sessionTag}-${randomBytes(3).toString("hex")}`,
          snapshotId ?? (await resolveBaseSnapshot()),
        );
        try {
          if (openOptions?.networkPolicy) {
            await box.updateNetworkPolicy(toBoxNetworkPolicy(openOptions.networkPolicy));
          }
        } catch (err) {
          // Never leave a half-configured box behind: eve will not persist state for a failed start.
          await box.delete().catch(() => {});
          throw err;
        }
        return { handle: createHandle(box), state: { boxId: box.id, version: 1 } };
      },

      async resume(_ctx, artifact, state) {
        requireArtifact(artifact);
        const { boxId } = requireState(state);
        let box: Box;
        try {
          box = await Box.get(boxId, connection);
          // `Box.get` also returns deleted boxes (their record lingers with that status), so check.
          const { status } = await box.getStatus();
          if (status === "deleted" || status === "error")
            throw new Error(`box status is "${status}"`);
        } catch (err) {
          throw new Error(
            `UpstashSandbox: the session's Upstash Box "${boxId}" is no longer available ` +
              `(${errorMessage(err)}). Call sandbox.delete() to start a fresh sandbox for this session.`,
            { cause: err },
          );
        }
        return createHandle(box);
      },
    };
  },
});
