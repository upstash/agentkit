import { config } from "dotenv";
import { describe, expect, it } from "vitest";
import { upstash } from "./sandbox.js";

config(); // load repo-root .env for UPSTASH_BOX_API_KEY
const hasBoxCreds = Boolean(process.env.UPSTASH_BOX_API_KEY);

describe("upstash() backend (offline)", () => {
  it("is a drop-in backend with the upstash-box provider id", () => {
    const backend = upstash({ runtime: "node24", resources: { vcpus: 2 } });
    expect(backend.providerId).toBe("upstash-box");
    expect(typeof backend.createSession).toBe("function");
  });
});

describe.skipIf(!hasBoxCreds)("upstash() backend (live Upstash Box)", () => {
  it("creates a session, runs a command, round-trips a file, and destroys it", async () => {
    const backend = upstash({ runtime: "node", resources: { vcpus: 2 } });
    const session = await backend.createSession();
    try {
      const result = await session.run({ command: "echo hello-box" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-box");

      await session.writeTextFile({ path: "note.txt", content: "agentkit" });
      expect(await session.readTextFile({ path: "note.txt" })).toContain("agentkit");
    } finally {
      await session.destroy();
    }
  }, 120_000);
});
