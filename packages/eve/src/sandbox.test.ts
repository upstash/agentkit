import { config } from "dotenv";
import { describe, expect, it } from "vitest";
import { Box } from "@upstash/box";
import { rewriteWorkspacePaths, toBoxPath, upstash } from "./sandbox.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

config(); // load repo-root .env for UPSTASH_BOX_API_KEY
const hasBoxCreds = Boolean(process.env.UPSTASH_BOX_API_KEY);

const createInput = {
  templateKey: null,
  sessionKey: "test-session",
  runtimeContext: { appRoot: process.cwd() },
} as const;

describe("upstash() backend (offline)", () => {
  it("implements Eve's two-phase SandboxBackend", () => {
    const backend = upstash({ runtime: "node", size: "small" });
    expect(backend.name).toBe("upstash");
    expect(typeof backend.create).toBe("function");
    expect(typeof backend.prewarm).toBe("function");
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
    expect(rewriteWorkspacePaths("ls /workspace/home")).toBe("ls /workspace/home"); // no double-map
    expect(rewriteWorkspacePaths("echo /workspaces")).toBe("echo /workspaces"); // word boundary respected
  });
});

describe.skipIf(!hasBoxCreds)("upstash() backend (live Upstash Box)", () => {
  it("creates a session, runs a command, round-trips a file, and disposes it", async () => {
    // keepAlive: false so dispose() deletes the box and cleans up after the test.
    const backend = upstash({ runtime: "node", size: "small", keepAlive: false });
    const handle = await backend.create(createInput);
    const session = handle.session;
    try {
      const result = await session.run({ command: "echo hello-box" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-box");

      // Bare commands run in Box's working dir, /workspace/home (not the off-limits /workspace).
      const pwd = await session.run({ command: "pwd" });
      expect(pwd.stdout.trim()).toBe("/workspace/home");

      // A relative write lands under /workspace/home, and Eve's `find /workspace …` (rewritten to
      // /workspace/home) finds it — the end-to-end path bridge.
      await session.writeTextFile({ path: "note.txt", content: "agentkit" });
      expect(await session.readTextFile({ path: "note.txt" })).toContain("agentkit");
      const found = await session.run({ command: "find /workspace -name note.txt" });
      expect(found.stdout).toContain("/workspace/home/note.txt");
    } finally {
      await handle.dispose();
    }
  }, 120_000);

  // Egress is denied by default — model-generated code in the box can't reach the network. Opening it
  // per-session via `use({ networkPolicy })` (Eve's flow) lets the same call through on the same box.
  it("denies network egress by default, allows it when opened", async () => {
    const fetchCmd = `node -e "fetch('https://example.com').then(r=>process.exit(r.ok?0:9)).catch(()=>process.exit(7))"`;

    const backend = upstash({ runtime: "node", keepAlive: false });
    const handle = await backend.create(createInput);
    try {
      const denied = await handle.session.run({ command: fetchCmd });
      expect(denied.exitCode).not.toBe(0); // egress blocked by default → fetch rejects

      await handle.useSessionFn({ networkPolicy: "allow-all" }); // open egress for this session
      const allowed = await handle.session.run({ command: fetchCmd });
      expect(allowed.exitCode).toBe(0); // egress allowed → fetch resolves
    } finally {
      await handle.dispose();
    }
  }, 180_000);
});

// Bug fix: prewarm (build/startup) and create (per request) run in different processes, so the
// template snapshot is recorded in a durable Redis registry — a second backend INSTANCE must reuse it
// rather than building a fresh, empty box (the "two boxes, first unused" + "missing seed files" bug).
describe.skipIf(!hasBoxCreds || !hasRedisCreds)(
  "upstash() template registry (live Box + Redis)",
  () => {
    it("create reuses the snapshot prewarm stored in Redis, across instances", async () => {
      const redis = testRedis();
      const templatePrefix = uniquePrefix("sandboxtpl"); // unique so reruns don't collide
      const templateKey = "tmpl-1";
      const cfg = { runtime: "node" as const, keepAlive: false, redis, templatePrefix };
      const prewarmInput = {
        templateKey,
        seedFiles: [{ path: "seeded.txt", content: "from-template" }],
        runtimeContext: { appRoot: process.cwd() },
      };
      const regKey = `${templatePrefix}:upstash:${templateKey}`;

      // One instance "prewarms" the template (bakes the seed file into a snapshot).
      const built = await upstash(cfg).prewarm(prewarmInput as never);
      expect(built.reused).toBe(false);
      const snapshotId = await redis.get<string>(regKey);
      expect(snapshotId).toBeTruthy();

      const runner = upstash(cfg); // a SEPARATE instance — mimics the per-request process
      try {
        // It must find the snapshot via Redis (not rebuild, not start empty).
        expect((await runner.prewarm(prewarmInput as never)).reused).toBe(true);

        const handle = await runner.create({
          templateKey,
          sessionKey: "s1",
          runtimeContext: { appRoot: process.cwd() },
        } as never);
        try {
          expect(await handle.session.readTextFile({ path: "seeded.txt" })).toContain(
            "from-template",
          );
        } finally {
          await handle.dispose();
        }
      } finally {
        if (snapshotId) await Box.deleteSnapshots({ snapshotIds: snapshotId }).catch(() => {});
        await redis.del(regKey).catch(() => {});
      }
    }, 240_000);
  },
);
