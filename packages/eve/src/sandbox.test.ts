import { Telemetry, ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  instrumentSandboxSession,
  withSandboxInstrumentation,
  type EveSandboxRunResult,
  type EveSandboxSession,
} from "./sandbox.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

function fakeSession(
  run: (opts: { command: string }) => Promise<EveSandboxRunResult>,
): EveSandboxSession {
  return {
    run,
    async readTextFile() {
      return "file-contents";
    },
  };
}

describe.skipIf(!hasRedisCreds)("eve sandbox instrumentation (live Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "test:eve-sbx");
  });

  it("caches run results so the same command runs once", async () => {
    const run = vi.fn(async ({ command }: { command: string }) => ({ stdout: `ran ${command}` }));
    const toolCache = new ToolCache({ redis, namespace: uniqueNamespace("eve-sbx") });
    const session = instrumentSandboxSession(fakeSession(run), { toolCache });

    const a = await session.run({ command: "echo hi" });
    const b = await session.run({ command: "echo hi" });
    expect(a.stdout).toBe("ran echo hi");
    expect(b.stdout).toBe("ran echo hi");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("traces each run via telemetry", async () => {
    const telemetry = new Telemetry({ redis, namespace: uniqueNamespace("eve-sbx-tel") });
    const session = instrumentSandboxSession(
      fakeSession(async ({ command }) => ({ stdout: command })),
      { telemetry, traceId: "sbx-trace" },
    );
    await session.run({ command: "ls -la" });

    const trace = await telemetry.getTrace("sbx-trace");
    expect(trace).toHaveLength(1);
    expect(trace[0]!.name).toBe("sandbox.run");
    expect(trace[0]!.type).toBe("tool");
    expect(trace[0]!.attributes.command).toBe("ls -la");
  });

  it("delegates non-run operations to the underlying session", async () => {
    const session = instrumentSandboxSession(
      fakeSession(async () => ({ stdout: "" })),
      {},
    );
    expect(await session.readTextFile!({ path: "f.txt" })).toBe("file-contents");
  });

  it("withSandboxInstrumentation instruments sessions obtained via use()", async () => {
    const run = vi.fn(async ({ command }: { command: string }) => ({ stdout: command }));
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

    // Simulate Eve invoking onSession with a real `use` that yields the fake session.
    await config.onSession!({ use: async () => fakeSession(run) });
    expect(run).toHaveBeenCalledTimes(1); // second run served from cache
  });
});
