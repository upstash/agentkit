import { ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  instrumentSandboxSession,
  upstash,
  withSandboxInstrumentation,
  type EveSandboxRunResult,
} from "./sandbox.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const hasBoxCreds = Boolean(process.env.UPSTASH_BOX_API_KEY);

/** A minimal runnable fake — enough for the instrumentation helpers. */
function fakeSession(run: (opts: { command: string }) => Promise<EveSandboxRunResult>) {
  return { run };
}

describe.skipIf(!hasRedisCreds)("eve sandbox instrumentation (live Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "test:eve-sbx");
  });

  it("caches run results so the same command runs once", async () => {
    const run = vi.fn(async ({ command }: { command: string }) => ({
      stdout: `ran ${command}`,
      stderr: "",
      exitCode: 0,
    }));
    const toolCache = new ToolCache({ redis, namespace: uniqueNamespace("eve-sbx") });
    const session = instrumentSandboxSession(fakeSession(run), { toolCache });

    expect((await session.run({ command: "echo hi" })).stdout).toBe("ran echo hi");
    expect((await session.run({ command: "echo hi" })).stdout).toBe("ran echo hi");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("withSandboxInstrumentation instruments sessions obtained via use()", async () => {
    const run = vi.fn(async ({ command }: { command: string }) => ({
      stdout: command,
      stderr: "",
      exitCode: 0,
    }));
    const toolCache = new ToolCache({ redis, namespace: uniqueNamespace("eve-sbx") });
    const config = withSandboxInstrumentation(
      {
        async onSession({ use }) {
          const session = await use();
          await session.run({ command: "npm run build" });
          await session.run({ command: "npm run build" });
        },
      },
      { toolCache },
    );
    // Simulate Eve invoking onSession with a `use` that yields the fake session.
    await config.onSession!({ use: async () => fakeSession(run) as never });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("upstash() backend (offline mapping)", () => {
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
