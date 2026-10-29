import { config } from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box } from "@upstash/box";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { SandboxSessionGoneError } from "eve/sandbox/provider";
import type { SandboxConnection, SandboxProviderImplementation } from "eve/sandbox/provider";
import {
  UpstashSandbox,
  rewriteWorkspacePaths,
  toBoxNetworkPolicy,
  toBoxPath,
  type UpstashSandboxEnvironmentOptions,
} from "./sandbox.js";

config(); // load repo-root .env for UPSTASH_BOX_API_KEY
const hasBoxCreds = Boolean(process.env.UPSTASH_BOX_API_KEY);

type Extensions = { setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> };
type Impl = SandboxProviderImplementation<
  { networkPolicy?: unknown } | undefined,
  { snapshotId: string | null },
  { boxId: string; version: 1 },
  Extensions
>;

/**
 * The provider implementation behind an environment. Eve keeps it under a private symbol on the
 * environment object and calls prepare/start/resume itself; tests drive those same calls directly,
 * since standing up the full eve runtime in a unit test isn't practical (the e2e eval does that).
 */
function implementationOf(options?: UpstashSandboxEnvironmentOptions): Impl {
  const env = UpstashSandbox.environment(options ?? {}) as unknown as Record<symbol, unknown>;
  for (const sym of Object.getOwnPropertySymbols(env)) {
    const v = env[sym] as { implementation?: Impl } | undefined;
    if (v && typeof v === "object" && v.implementation) return v.implementation;
  }
  throw new Error("provider runtime not found on environment");
}

const host = {} as never;
const sessionCtx = (id = "test-session") =>
  ({ host, session: { id }, kind: "session", storagePath: "/tmp/eve-test" }) as never;
/** What eve passes to `prepare()`; `populate` stands in for eve seeding `files` over a connection. */
const prepareCtx = (
  overrides: { isEmpty?: boolean; populate?: (c: SandboxConnection<object>) => Promise<void> } = {},
) =>
  ({
    files: { list: async () => [], read: async () => new Uint8Array(), readText: async () => "" },
    isEmpty: true,
    storagePath: "/tmp/eve-test",
    log: () => {},
    populate: async () => {},
    resolveProjectPath: (path: string) => path,
    resourcesDirectory: async () => undefined,
    templateKey: () => "abc123",
    ...overrides,
  }) as never;
const noArtifact = { snapshotId: null } as const;
const endOptions = { reason: "deleted" } as const;

function fakeBox(calls: string[] = [], status = "idle") {
  return {
    id: "box_fake",
    getStatus: vi.fn(async () => ({ status })),
    pause: vi.fn(async () => void calls.push("pause")),
    delete: vi.fn(async () => void calls.push("delete")),
    updateNetworkPolicy: vi.fn(async () => void calls.push("policy")),
    files: { read: vi.fn(), write: vi.fn(async () => {}) },
    exec: { command: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", result: "" })) },
  };
}

/** `Box.get` finding nothing — a session with no box yet. */
const noExistingBox = () => vi.spyOn(Box, "get").mockRejectedValue(new Error("not found"));

afterEach(() => vi.restoreAllMocks());

describe("UpstashSandbox provider (offline)", () => {
  it("is an eve sandbox provider whose environments open sessions", () => {
    expect(UpstashSandbox.name).toBe("upstash");
    const env = UpstashSandbox.environment({ runtime: "node", size: "small" });
    expect(env.provider).toBe("upstash");
    expect(typeof env.open).toBe("function");
    const impl = implementationOf();
    expect(typeof impl.prepare).toBe("function");
    expect(typeof impl.start).toBe("function");
    expect(typeof impl.resume).toBe("function");
    expect(typeof impl.onSessionEnd).toBe("function");
  });

  // Eve roots its tools at /workspace; a Box session lives in /workspace/home.
  it("bridges Eve's /workspace paths to Box's /workspace/home", () => {
    expect(toBoxPath("note.txt")).toBe("/workspace/home/note.txt"); // relative → under home
    expect(toBoxPath("/workspace")).toBe("/workspace/home"); // the root itself
    expect(toBoxPath("/workspace/sub/a.js")).toBe("/workspace/home/sub/a.js"); // nested
    expect(toBoxPath("/workspace/home/x")).toBe("/workspace/home/x"); // already box-rooted (no double-map)
    expect(toBoxPath("/tmp/x")).toBe("/tmp/x"); // unrelated absolute → untouched
  });

  it("rewrites /workspace inside raw commands (Eve's find/grep tools)", () => {
    expect(rewriteWorkspacePaths("find /workspace -type f")).toBe("find /workspace/home -type f");
    expect(rewriteWorkspacePaths("node /workspace/app.js")).toBe("node /workspace/home/app.js");
    expect(rewriteWorkspacePaths("D=/workspace/x; echo $D")).toBe("D=/workspace/home/x; echo $D");
    expect(rewriteWorkspacePaths("ls /workspace/home")).toBe("ls /workspace/home"); // no double-map
    expect(rewriteWorkspacePaths("echo /workspaces")).toBe("echo /workspaces"); // word boundary respected
  });

  it("does NOT rewrite /workspace mid-token (URLs, relative paths)", () => {
    expect(rewriteWorkspacePaths("curl https://api.example.com/workspace/items")).toBe(
      "curl https://api.example.com/workspace/items",
    );
    expect(rewriteWorkspacePaths("cat ./workspace/x")).toBe("cat ./workspace/x"); // relative, untouched
  });

  // Box's policy is a plain domain/CIDR allow-list. It must not silently drop Eve's per-domain
  // credential-brokering rules (transform / forwardURL); those throw instead.
  it("maps plain network policies and throws on per-domain rules", () => {
    expect(toBoxNetworkPolicy("deny-all")).toEqual({ mode: "deny-all" });
    expect(toBoxNetworkPolicy("allow-all")).toEqual({ mode: "allow-all" });
    expect(toBoxNetworkPolicy({ allow: ["github.com"] } as never)).toEqual({
      mode: "custom",
      allowedDomains: ["github.com"],
    });
    expect(toBoxNetworkPolicy({ allow: { "github.com": [], "*": [] } } as never)).toEqual({
      mode: "custom",
      allowedDomains: ["github.com", "*"],
    });
    expect(() =>
      toBoxNetworkPolicy({
        allow: { "github.com": [{ transform: [{ headers: { authorization: "Basic x" } }] }] },
      } as never),
    ).toThrow(/attachHeaders/);
  });

  it("prepare with nothing to bake creates no box and no snapshot", async () => {
    const create = vi.spyOn(Box, "create");
    const fromSnapshot = vi.spyOn(Box, "fromSnapshot");
    await expect(implementationOf().prepare(prepareCtx())).resolves.toEqual({ snapshotId: null });
    expect(create).not.toHaveBeenCalled();
    expect(fromSnapshot).not.toHaveBeenCalled();
  });

  it("prepare populates a temporary box over a connection, snapshots it and deletes the box", async () => {
    const calls: string[] = [];
    const box = { ...fakeBox(calls), snapshot: vi.fn(async () => ({ id: "snap_new" })) };
    vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    const populate = vi.fn(async (c: SandboxConnection<object>) => {
      // eve's seeding goes through the connection, so it must reach the box
      await c.writeFiles({
        files: [{ path: "/workspace/seed.txt", content: new TextEncoder().encode("hi") }],
      });
    });
    await expect(
      implementationOf().prepare(prepareCtx({ isEmpty: false, populate })),
    ).resolves.toEqual({ snapshotId: "snap_new" });
    expect(populate).toHaveBeenCalledOnce();
    expect(box.files.write).toHaveBeenCalledWith({
      path: "/workspace/home/seed.txt",
      content: Buffer.from("hi").toString("base64"),
      encoding: "base64",
    });
    expect(box.snapshot).toHaveBeenCalledWith({ name: "eve-abc123" });
    expect(calls).toEqual(["delete"]); // the temporary box never outlives prepare
  });

  it("start creates a deny-all, pause-on-idle box and returns minimal JSON state", async () => {
    noExistingBox();
    const box = fakeBox();
    const create = vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    const { state } = await implementationOf({ runtime: "node", size: "small" }).start(
      sessionCtx(),
      undefined,
      noArtifact,
    );
    expect(state).toEqual({ boxId: "box_fake", version: 1 });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state); // eve persists it as JSON
    const config = create.mock.calls[0]![0]!;
    expect(config).toMatchObject({
      runtime: "node",
      size: "small",
      keepAlive: false,
      networkPolicy: { mode: "deny-all" },
    });
    expect(config.name).toMatch(/^eve-[0-9a-f]{16}$/);
    expect(box.updateNetworkPolicy).not.toHaveBeenCalled(); // default stays deny-all
  });

  // eve requires start() to be an idempotent upsert: the same session must find its box again.
  it("start names the box after the session and reuses a live one instead of creating another", async () => {
    const get = noExistingBox();
    const create = vi.spyOn(Box, "create").mockResolvedValue(fakeBox() as unknown as Box);
    const impl = implementationOf();
    await impl.start(sessionCtx("s"), undefined, noArtifact);
    await impl.start(sessionCtx("other"), undefined, noArtifact);
    const [a, b] = create.mock.calls.map((c) => c[0]!.name!);
    expect(a).not.toBe(b);
    expect(get.mock.calls[0]![0]).toBe(a); // looked up by the same name it creates

    create.mockClear();
    get.mockResolvedValue({ ...fakeBox(), id: "box_existing" } as unknown as Box);
    const again = await impl.start(sessionCtx("s"), undefined, noArtifact);
    expect(again.state).toEqual({ boxId: "box_existing", version: 1 });
    expect(create).not.toHaveBeenCalled();
  });

  it("start falls back to a suffixed name when a lingering record holds the session's name", async () => {
    noExistingBox();
    const create = vi
      .spyOn(Box, "create")
      .mockRejectedValueOnce(new Error("name already taken"))
      .mockResolvedValueOnce(fakeBox() as unknown as Box);
    await implementationOf().start(sessionCtx("s"), undefined, noArtifact);
    const [first, second] = create.mock.calls.map((c) => c[0]!.name!);
    expect(second).toMatch(new RegExp(`^${first}-[0-9a-f]{6}$`));
  });

  it("start applies open({ networkPolicy }) to the new box", async () => {
    noExistingBox();
    const box = fakeBox();
    vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    await implementationOf().start(sessionCtx(), { networkPolicy: "allow-all" }, noArtifact);
    expect(box.updateNetworkPolicy).toHaveBeenCalledWith({ mode: "allow-all" });
  });

  it("start deletes the box when the open policy is unsupported (no orphan)", async () => {
    noExistingBox();
    const calls: string[] = [];
    const box = fakeBox(calls);
    vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    const transform = {
      allow: { "api.example.com": [{ transform: [{ headers: { authorization: "x" } }] }] },
    };
    await expect(
      implementationOf().start(sessionCtx(), { networkPolicy: transform }, noArtifact),
    ).rejects.toThrow(/attachHeaders/);
    expect(calls).toEqual(["delete"]);
  });

  it("start restores from the prepared snapshot, and fails loudly if it's gone", async () => {
    noExistingBox();
    const fromSnapshot = vi
      .spyOn(Box, "fromSnapshot")
      .mockResolvedValueOnce(fakeBox() as unknown as Box)
      .mockRejectedValueOnce(new Error("Snapshot is not ready"));
    const create = vi.spyOn(Box, "create");
    const impl = implementationOf();
    await impl.start(sessionCtx(), undefined, { snapshotId: "snap_1" });
    expect(fromSnapshot.mock.calls[0]![0]).toBe("snap_1");
    // A missing prepared snapshot must not silently fall back to an empty box (the session would
    // lose its workspace seeds, skills and prepare() output).
    await expect(impl.start(sessionCtx(), undefined, { snapshotId: "snap_1" })).rejects.toThrow(
      /rebuild/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("start falls back to baseSnapshot when nothing was prepared", async () => {
    noExistingBox();
    const fromSnapshot = vi
      .spyOn(Box, "fromSnapshot")
      .mockResolvedValue(fakeBox() as unknown as Box);
    await implementationOf({ baseSnapshot: async () => "snap_base" }).start(
      sessionCtx(),
      undefined,
      noArtifact,
    );
    expect(fromSnapshot.mock.calls[0]![0]).toBe("snap_base");
  });

  it("resume reattaches by boxId and fails (not recreates) when the box is gone", async () => {
    const get = vi
      .spyOn(Box, "get")
      .mockResolvedValueOnce(fakeBox() as unknown as Box)
      .mockRejectedValueOnce(new Error("not found"))
      // Box.get resolves for a deleted box too — its record lingers with status "deleted".
      .mockResolvedValueOnce(fakeBox([], "deleted") as unknown as Box);
    const create = vi.spyOn(Box, "create");
    const impl = implementationOf({ apiKey: "k" });
    await impl.resume(sessionCtx(), noArtifact, { boxId: "box_1", version: 1 });
    expect(get).toHaveBeenCalledWith("box_1", { apiKey: "k" });
    for (let i = 0; i < 2; i++) {
      const err = await impl
        .resume(sessionCtx(), noArtifact, { boxId: "box_1", version: 1 })
        .catch((e: unknown) => e);
      // eve distinguishes a gone sandbox from any other resume failure by this class
      expect(SandboxSessionGoneError.is(err)).toBe(true);
      expect((err as Error).message).toMatch(/sandbox\.delete\(\)/);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("resume rejects malformed state and artifacts", async () => {
    const impl = implementationOf();
    await expect(impl.resume(sessionCtx(), noArtifact, {} as never)).rejects.toThrow(/state/);
    await expect(
      impl.resume(sessionCtx(), {} as never, { boxId: "b", version: 1 }),
    ).rejects.toThrow(/artifact/);
  });

  // stop PAUSES (compute released, box still resumable); onSessionEnd DESTROYS the box.
  it("maps connection.stop() to Box pause, propagating failures", async () => {
    noExistingBox();
    const calls: string[] = [];
    const box = fakeBox(calls);
    vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    const { connection } = await implementationOf().start(sessionCtx(), undefined, noArtifact);
    await connection.stop();
    expect(calls).toEqual(["pause"]);

    box.pause.mockRejectedValue(new Error("keep-alive boxes cannot be paused"));
    await expect(connection.stop()).rejects.toThrow(/keep-alive/);
  });

  it("onSessionEnd deletes the recorded box, or finds it by session name without state", async () => {
    const calls: string[] = [];
    const get = vi.spyOn(Box, "get").mockResolvedValue(fakeBox(calls) as unknown as Box);
    const impl = implementationOf({ apiKey: "k" });

    await impl.onSessionEnd(sessionCtx("s"), { boxId: "box_1", version: 1 }, endOptions);
    expect(get).toHaveBeenLastCalledWith("box_1", { apiKey: "k" });
    expect(calls).toEqual(["delete"]);

    await impl.onSessionEnd(sessionCtx("s"), null, endOptions);
    expect(get.mock.lastCall![0]).toMatch(/^eve-[0-9a-f]{16}$/);
    expect(calls).toEqual(["delete", "delete"]);
  });

  it("onSessionEnd succeeds when nothing exists and skips an already-deleted box", async () => {
    const calls: string[] = [];
    const impl = implementationOf();
    vi.spyOn(Box, "get").mockRejectedValueOnce(new Error("not found"));
    await expect(impl.onSessionEnd(sessionCtx(), null, endOptions)).resolves.toBeUndefined();

    vi.spyOn(Box, "get").mockResolvedValueOnce(fakeBox(calls, "deleted") as unknown as Box);
    await expect(
      impl.onSessionEnd(sessionCtx(), { boxId: "box_1", version: 1 }, endOptions),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("onSessionEnd rejects an already-aborted signal without deleting", async () => {
    const calls: string[] = [];
    vi.spyOn(Box, "get").mockResolvedValue(fakeBox(calls) as unknown as Box);
    await expect(
      implementationOf().onSessionEnd(sessionCtx(), null, {
        ...endOptions,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  describe("connection", () => {
    async function connect(box = fakeBox()) {
      noExistingBox();
      vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
      const { connection } = await implementationOf().start(sessionCtx(), undefined, noArtifact);
      return { box, connection };
    }

    it("writeFiles maps paths and sends base64", async () => {
      const { box, connection } = await connect();
      await connection.writeFiles({
        files: [{ path: "/workspace/a/b.bin", content: new Uint8Array([0, 1, 255]) }],
      });
      expect(box.files.write).toHaveBeenCalledWith({
        path: "/workspace/home/a/b.bin",
        content: Buffer.from([0, 1, 255]).toString("base64"),
        encoding: "base64",
      });
    });

    it("readFile returns null only for a missing path and rethrows otherwise", async () => {
      const { box, connection } = await connect();
      box.files.read.mockResolvedValueOnce(Buffer.from("hi").toString("base64"));
      expect(await readText(connection, "/workspace/x")).toBe("hi");

      box.files.read.mockRejectedValueOnce(new Error("no such file"));
      box.exec.command.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "", result: "" });
      expect(await connection.readFile({ path: "/workspace/missing" })).toBeNull();

      box.files.read.mockRejectedValueOnce(new Error("is a directory"));
      await expect(connection.readFile({ path: "/workspace" })).rejects.toThrow(/directory/);
    });

    it("removePath maps the path and fails when rm does", async () => {
      const { box, connection } = await connect();
      await connection.removePath({ path: "/workspace/d", recursive: true, force: true });
      expect(box.exec.command).toHaveBeenCalledWith("rm -rf '/workspace/home/d'");
      box.exec.command.mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "nope",
        result: "",
      });
      await expect(connection.removePath({ path: "/workspace/d" })).rejects.toThrow(/nope/);
    });

    it("spawn refuses a writable stdin, which Box sessions cannot provide", async () => {
      const { connection } = await connect();
      expect(() =>
        connection.spawn({ command: "cat", env: {}, workingDirectory: "/workspace", stdin: true }),
      ).toThrow(/stdin/);
    });

    it("exposes setNetworkPolicy as a session extension", async () => {
      const { box, connection } = await connect();
      await connection.extensions!.setNetworkPolicy("allow-all");
      expect(box.updateNetworkPolicy).toHaveBeenCalledWith({ mode: "allow-all" });
    });
  });
});

/** Run a command over a connection and collect its output. */
async function sh(
  connection: SandboxConnection<object>,
  command: string,
  options: { env?: Record<string, string>; workingDirectory?: string } = {},
) {
  const p = await connection.spawn({
    command,
    env: options.env ?? {},
    workingDirectory: options.workingDirectory ?? "/workspace",
  });
  const text = async (s: ReadableStream<Uint8Array>) => new Response(s).text();
  const [stdout, stderr, { exitCode }] = await Promise.all([
    text(p.stdout),
    text(p.stderr),
    p.wait(),
  ]);
  return { exitCode, stdout, stderr };
}

const readText = async (connection: SandboxConnection<object>, path: string) => {
  const bytes = await connection.readFile({ path });
  return bytes === null ? null : new TextDecoder().decode(bytes as Uint8Array);
};

describe.skipIf(!hasBoxCreds)("UpstashSandbox provider (live Upstash Box)", () => {
  const fetchCmd = `node -e "fetch('https://example.com').then(r=>process.exit(r.ok?0:9)).catch(()=>process.exit(7))"`;
  const live = (id: string) => `${id}-${Math.random().toString(36).slice(2, 8)}`;

  // The whole lifecycle eve drives, against real Box: prepare (populate over a connection) →
  // start from the snapshot → session ops → stop (pause) → resume by boxId → end → resume fails.
  it("prepare → start → stop → resume → end", async () => {
    const impl = implementationOf({ runtime: "node", size: "small" });
    const enc = new TextEncoder();
    const artifact = await impl.prepare(
      prepareCtx({
        isEmpty: false,
        // What eve's populate does: seed the workspace and skills, then run the authored prepare.
        populate: async (c) => {
          const home = (await sh(c, 'printf %s "$HOME"')).stdout;
          await c.writeFiles({
            files: [
              { path: "/workspace/seed/README.txt", content: enc.encode("seeded") },
              { path: `${home}/.agents/skills/demo/SKILL.md`, content: enc.encode("# demo") },
              { path: "/workspace/prepared.txt", content: enc.encode("from-prepare") },
            ],
          });
        },
      }),
    );
    expect(artifact.snapshotId).toEqual(expect.any(String));
    const sessionId = live("live");
    const boxes: string[] = [];
    try {
      const { connection, state } = await impl.start(sessionCtx(sessionId), undefined, artifact);
      boxes.push(state.boxId);

      // Everything prepare baked is in the session's box, at eve's paths.
      expect(await readText(connection, "/workspace/seed/README.txt")).toBe("seeded");
      expect(await readText(connection, "/workspace/prepared.txt")).toBe("from-prepare");
      expect((await sh(connection, "cat $HOME/.agents/skills/demo/SKILL.md")).stdout).toBe(
        "# demo",
      );

      // start is idempotent: the same session finds the same box.
      const again = await impl.start(sessionCtx(sessionId), undefined, artifact);
      expect(again.state.boxId).toBe(state.boxId);

      // spawn: separate stdout/stderr, exit code, env reaches every command, cwd is honoured.
      const r = await sh(connection, "echo out; echo err >&2; echo $A; pwd; exit 3", {
        env: { A: "it's set" },
        workingDirectory: "/workspace/seed",
      });
      expect(r).toEqual({
        exitCode: 3,
        stdout: "out\nit's set\n/workspace/home/seed\n",
        stderr: "err\n",
      });

      // Egress: deny-all by default, opened per session.
      expect((await sh(connection, fetchCmd)).exitCode).not.toBe(0);
      await connection.extensions!.setNetworkPolicy("allow-all");
      expect((await sh(connection, fetchCmd)).exitCode).toBe(0);

      // Files round-trip (binary), removePath works, and a missing path reads as null.
      await connection.writeFiles({
        files: [{ path: "bin/x.bin", content: new Uint8Array([0, 1, 255]) }],
      });
      expect(Array.from((await connection.readFile({ path: "bin/x.bin" })) as Uint8Array)).toEqual([
        0, 1, 255,
      ]);
      await connection.removePath({ path: "bin", recursive: true, force: true });
      expect(await connection.readFile({ path: "bin/x.bin" })).toBeNull();

      // stop = pause; resume reattaches the SAME box (state survives), network policy included.
      await connection.writeFiles({
        files: [{ path: "turn1.txt", content: enc.encode("kept") }],
      });
      await connection.stop();
      const resumed = await impl.resume(sessionCtx(sessionId), artifact, state);
      expect(await readText(resumed, "turn1.txt")).toBe("kept");
      expect((await sh(resumed, fetchCmd)).exitCode).toBe(0);

      // end = gone for good; resuming it now fails instead of silently making a new box.
      await impl.onSessionEnd(sessionCtx(sessionId), state, { reason: "deleted" });
      const err = await impl
        .resume(sessionCtx(sessionId), artifact, state)
        .catch((e: unknown) => e);
      expect(SandboxSessionGoneError.is(err)).toBe(true);
      // ...and ending again, or ending a session that never recorded state, is a no-op.
      await impl.onSessionEnd(sessionCtx(sessionId), state, { reason: "deleted" });
      await impl.onSessionEnd(sessionCtx(live("never")), null, { reason: "deleted" });
    } finally {
      await Box.delete({ boxIds: boxes }).catch(() => {});
      await Box.deleteSnapshots({ snapshotIds: artifact.snapshotId! }).catch(() => {});
    }
  }, 240_000);

  // spawn streams output and is killable; eve's turn abort signal kills a running command.
  it("spawn streams and kills; an aborted spawn kills its process", async () => {
    const impl = implementationOf({ runtime: "node" });
    const { connection, state } = await impl.start(
      sessionCtx(live("spawn")),
      undefined,
      noArtifact,
    );
    try {
      const p = await connection.spawn({
        command: "echo first; sleep 30; echo never",
        env: {},
        workingDirectory: "/workspace",
      });
      const reader = p.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("first"); // streamed before exit
      reader.releaseLock();
      await p.kill();
      expect((await p.wait()).exitCode).not.toBe(0);

      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 1_000);
      const sleeper = await connection.spawn({
        command: "sleep 30",
        env: {},
        workingDirectory: "/workspace",
        signal: ac.signal,
      });
      await sleeper.wait().then(
        ({ exitCode }) => expect(exitCode).not.toBe(0),
        () => {}, // a killed process may also reject
      );
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await Box.delete({ boxIds: state.boxId }).catch(() => {});
    }
  }, 120_000);

  // Per-domain transform rules have no Box equivalent: rejected with a pointer to attachHeaders,
  // which is the supported way to broker credentials (set in the environment options).
  it("rejects per-domain transform rules; attachHeaders + a plain allow-list work", async () => {
    const impl = implementationOf({
      runtime: "node",
      attachHeaders: { "example.com": { Authorization: "Bearer test" } },
    });
    const { connection, state } = await impl.start(
      sessionCtx(live("net")),
      { networkPolicy: { allow: ["example.com"] } },
      noArtifact,
    );
    try {
      await expect(
        connection.extensions!.setNetworkPolicy({
          allow: { "example.com": [{ transform: [{ headers: { authorization: "x" } }] }] },
        } as never),
      ).rejects.toThrow(/attachHeaders/);
      expect((await sh(connection, fetchCmd)).exitCode).toBe(0);
    } finally {
      await Box.delete({ boxIds: state.boxId }).catch(() => {});
    }
  }, 120_000);
});
