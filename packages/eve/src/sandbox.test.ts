import { config } from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box } from "@upstash/box";
import type { SandboxProviderImplementation } from "eve/sandbox/provider";
import type { MutableNetworkSandboxSession } from "eve/sandbox";
import {
  UpstashSandbox,
  rewriteWorkspacePaths,
  toBoxNetworkPolicy,
  toBoxPath,
  type UpstashSandboxEnvironmentOptions,
} from "./sandbox.js";

config(); // load repo-root .env for UPSTASH_BOX_API_KEY
const hasBoxCreds = Boolean(process.env.UPSTASH_BOX_API_KEY);

type Impl = SandboxProviderImplementation<
  { networkPolicy?: unknown } | undefined,
  { snapshotId: string | null },
  { boxId: string; version: 1 },
  MutableNetworkSandboxSession
>;

/**
 * The provider implementation behind an environment. Eve keeps it under a private symbol on the
 * environment object and calls prepare/start/resume itself; tests drive those same calls directly,
 * since standing up the full eve runtime in a unit test isn't practical (the e2e eval does that).
 */
function implementationOf(options?: UpstashSandboxEnvironmentOptions): Impl {
  const env = UpstashSandbox.environment(options) as unknown as Record<symbol, unknown>;
  for (const sym of Object.getOwnPropertySymbols(env)) {
    const v = env[sym] as { implementation?: Impl } | undefined;
    if (v && typeof v === "object" && v.implementation) return v.implementation;
  }
  throw new Error("provider runtime not found on environment");
}

const host = {} as never;
const sessionCtx = (id = "test-session") =>
  ({ host, session: { id }, storagePath: "/tmp/eve-test" }) as never;
const prepareCtx = (resources: unknown = { source: { kind: "none" } }) =>
  ({
    files: { list: async () => [], read: async () => new Uint8Array(), readText: async () => "" },
    host,
    resources,
    sourceRevision: "rev-test",
    storagePath: "/tmp/eve-test",
  }) as never;
const noArtifact = { snapshotId: null } as const;

function fakeBox(calls: string[] = [], status = "idle") {
  return {
    id: "box_fake",
    getStatus: vi.fn(async () => ({ status })),
    pause: vi.fn(async () => void calls.push("pause")),
    delete: vi.fn(async () => void calls.push("delete")),
    updateNetworkPolicy: vi.fn(async () => void calls.push("policy")),
  };
}

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

  it("start creates a deny-all, pause-on-idle box and returns minimal JSON state", async () => {
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
    expect(config.name).toMatch(/^eve-[0-9a-f]{12}-[0-9a-f]{6}$/);
    expect(box.updateNetworkPolicy).not.toHaveBeenCalled(); // default stays deny-all
  });

  it("start gives each start its own box name (names are account-wide)", async () => {
    const create = vi.spyOn(Box, "create").mockResolvedValue(fakeBox() as unknown as Box);
    const impl = implementationOf();
    await impl.start(sessionCtx("s"), undefined, noArtifact);
    await impl.start(sessionCtx("s"), undefined, noArtifact);
    const [a, b] = create.mock.calls.map((c) => c[0]!.name!);
    expect(a!.slice(0, 16)).toBe(b!.slice(0, 16)); // same session hash
    expect(a).not.toBe(b);
  });

  it("start applies open({ networkPolicy }) to the new box", async () => {
    const box = fakeBox();
    vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    await implementationOf().start(sessionCtx(), { networkPolicy: "allow-all" }, noArtifact);
    expect(box.updateNetworkPolicy).toHaveBeenCalledWith({ mode: "allow-all" });
  });

  it("start deletes the box when the open policy is unsupported (no orphan)", async () => {
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
      await expect(
        impl.resume(sessionCtx(), noArtifact, { boxId: "box_1", version: 1 }),
      ).rejects.toThrow(/sandbox\.delete\(\)/);
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

  // stop/shutdown PAUSE (compute released, box still resumable), delete DESTROYS the box.
  it("maps stop/shutdown to Box pause and delete to Box delete", async () => {
    const calls: string[] = [];
    vi.spyOn(Box, "create").mockResolvedValue(fakeBox(calls) as unknown as Box);
    const { handle } = await implementationOf().start(sessionCtx(), undefined, noArtifact);

    await handle.onSessionStop();
    await handle.onRuntimeShutdown();
    expect(calls).toEqual(["pause", "pause"]);

    await handle.onSessionDelete();
    expect(calls).toEqual(["pause", "pause", "delete"]);

    // Gone: repeat teardown is a no-op (eve can still call shutdown on a deleted handle).
    await handle.onSessionDelete();
    await handle.onSessionStop();
    await handle.onRuntimeShutdown();
    expect(calls).toEqual(["pause", "pause", "delete"]);
  });

  it("stop propagates pause failures; shutdown tolerates them", async () => {
    const box = fakeBox();
    box.pause.mockRejectedValue(new Error("keep-alive boxes cannot be paused"));
    vi.spyOn(Box, "create").mockResolvedValue(box as unknown as Box);
    const { handle } = await implementationOf().start(sessionCtx(), undefined, noArtifact);
    await expect(handle.onSessionStop()).rejects.toThrow(/keep-alive/);
    await expect(handle.onRuntimeShutdown()).resolves.toBeUndefined();
  });

  it("delete rejects an already-aborted signal without deleting", async () => {
    const calls: string[] = [];
    vi.spyOn(Box, "create").mockResolvedValue(fakeBox(calls) as unknown as Box);
    const { handle } = await implementationOf().start(sessionCtx(), undefined, noArtifact);
    await expect(handle.onSessionDelete({ abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!hasBoxCreds)("UpstashSandbox provider (live Upstash Box)", () => {
  const fetchCmd = `node -e "fetch('https://example.com').then(r=>process.exit(r.ok?0:9)).catch(()=>process.exit(7))"`;

  // The whole lifecycle eve drives, against real Box: prepare (workspace seed + skill + hook) →
  // start from the snapshot → session ops → stop (pause) → resume by boxId → delete → resume fails.
  it("prepare → start → stop → resume → delete", async () => {
    const impl = implementationOf({
      runtime: "node",
      size: "small",
      async prepare(sandbox) {
        await sandbox.writeTextFile({ path: "prepared.txt", content: "from-prepare" });
      },
    });
    const resources = {
      source: { kind: "inline", key: "k" },
      workspace: {
        key: "k:workspace",
        mountPath: "/eve/resources/workspace",
        targetPath: "/workspace",
        files: [{ relativePath: "seed/README.txt", content: "seeded" }],
      },
      skills: {
        key: "k:skills",
        mountPath: "/eve/resources/skills",
        targetPath: "$HOME/.agents/skills",
        files: [{ relativePath: "demo/SKILL.md", content: new TextEncoder().encode("# demo") }],
      },
    };
    const artifact = await impl.prepare(prepareCtx(resources));
    expect(artifact.snapshotId).toEqual(expect.any(String));
    const boxes: string[] = [];
    try {
      const { handle, state } = await impl.start(sessionCtx("live"), undefined, artifact);
      boxes.push(state.boxId);
      const s = handle.sandbox;

      // Everything prepare baked is in the session's box, at eve's paths.
      expect(await s.readTextFile({ path: "/workspace/seed/README.txt" })).toBe("seeded");
      expect(await s.readTextFile({ path: "prepared.txt" })).toBe("from-prepare");
      const skill = await s.run({ command: "cat $HOME/.agents/skills/demo/SKILL.md" });
      expect(skill.stdout).toBe("# demo");

      // run: separate stdout/stderr, exit code, env reaches every command, cwd is honoured.
      const r = await s.run({
        command: "echo out; echo err >&2; echo $A; pwd; exit 3",
        env: { A: "it's set" },
        workingDirectory: "/workspace/seed",
      });
      expect(r).toEqual({
        exitCode: 3,
        stdout: "out\nit's set\n/workspace/home/seed\n",
        stderr: "err\n",
      });

      // Egress: deny-all by default, opened per session.
      expect((await s.run({ command: fetchCmd })).exitCode).not.toBe(0);
      await s.setNetworkPolicy("allow-all");
      expect((await s.run({ command: fetchCmd })).exitCode).toBe(0);

      // Files round-trip (text + binary), removePath works.
      await s.writeBinaryFile({ path: "bin/x.bin", content: new Uint8Array([0, 1, 255]) });
      expect(Array.from((await s.readBinaryFile({ path: "bin/x.bin" }))!)).toEqual([0, 1, 255]);
      await s.removePath({ path: "bin", recursive: true, force: true });
      expect(await s.readBinaryFile({ path: "bin/x.bin" })).toBeNull();

      // stop = pause; resume reattaches the SAME box (state survives), network policy included.
      await s.writeTextFile({ path: "turn1.txt", content: "kept" });
      await handle.onSessionStop();
      const resumed = await impl.resume(sessionCtx("live"), artifact, state);
      expect(await resumed.sandbox.readTextFile({ path: "turn1.txt" })).toBe("kept");
      expect((await resumed.sandbox.run({ command: fetchCmd })).exitCode).toBe(0);

      // delete = gone for good; resuming it now fails instead of silently making a new box.
      await resumed.onSessionDelete();
      await expect(impl.resume(sessionCtx("live"), artifact, state)).rejects.toThrow(
        /no longer available/,
      );
    } finally {
      await Box.delete({ boxIds: boxes }).catch(() => {});
      await Box.deleteSnapshots({ snapshotIds: artifact.snapshotId! }).catch(() => {});
    }
  }, 240_000);

  // spawn streams output and is killable; eve's turn abort signal kills a running command.
  it("spawn streams and kills; an aborted run kills its process", async () => {
    const impl = implementationOf({ runtime: "node" });
    const { handle, state } = await impl.start(sessionCtx("spawn"), undefined, noArtifact);
    try {
      const s = handle.sandbox;
      const p = await s.spawn({ command: "echo first; sleep 30; echo never" });
      const reader = p.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("first"); // streamed before exit
      reader.releaseLock();
      await p.kill();
      expect((await p.wait()).exitCode).not.toBe(0);

      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 1_000);
      await expect(s.run({ command: "sleep 30", abortSignal: ac.signal })).rejects.toThrow();
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
    const { handle, state } = await impl.start(
      sessionCtx("net"),
      { networkPolicy: { allow: ["example.com"] } },
      noArtifact,
    );
    try {
      await expect(
        handle.sandbox.setNetworkPolicy({
          allow: { "example.com": [{ transform: [{ headers: { authorization: "x" } }] }] },
        } as never),
      ).rejects.toThrow(/attachHeaders/);
      expect((await handle.sandbox.run({ command: fetchCmd })).exitCode).toBe(0);
    } finally {
      await Box.delete({ boxIds: state.boxId }).catch(() => {});
    }
  }, 120_000);
});
