import { config } from "dotenv";
import { describe, expect, it } from "vitest";
import { upstash } from "./sandbox.js";

config(); // load repo-root .env for UPSTASH_BOX_API_KEY
const hasBoxCreds = Boolean(process.env.UPSTASH_BOX_API_KEY);

const createInput = {
  templateKey: null,
  sessionKey: "test-session",
  runtimeContext: { appRoot: process.cwd() },
} as const;

describe("upstash() backend (offline)", () => {
  it("implements Eve's two-phase SandboxBackend", () => {
    const backend = upstash({ runtime: "node24", resources: { vcpus: 2 } });
    expect(backend.name).toBe("upstash");
    expect(typeof backend.create).toBe("function");
    expect(typeof backend.prewarm).toBe("function");
  });
});

describe.skipIf(!hasBoxCreds)("upstash() backend (live Upstash Box)", () => {
  it("creates a session, runs a command, round-trips a file, and disposes it", async () => {
    // keepAlive: false so dispose() deletes the box and cleans up after the test.
    const backend = upstash({ runtime: "node", resources: { vcpus: 2 }, keepAlive: false });
    const handle = await backend.create(createInput);
    const session = handle.session;
    try {
      const result = await session.run({ command: "echo hello-box" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-box");

      await session.writeTextFile({ path: "note.txt", content: "agentkit" });
      expect(await session.readTextFile({ path: "note.txt" })).toContain("agentkit");
    } finally {
      await handle.dispose();
    }
  }, 120_000);
});
