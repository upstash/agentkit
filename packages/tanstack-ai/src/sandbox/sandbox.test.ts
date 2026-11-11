import { afterAll, describe, expect, it } from "vitest";
import {
  runDurableRunFieldsConformance,
  runSandboxCheckpointForkConformance,
  runSandboxCheckpointStoreConformance,
  runSandboxInstanceStoreConformance,
} from "@tanstack/ai-sandbox/testkit";
import { upstashPersistence } from "../persistence/persistence.js";
import { upstashSandboxCheckpointStore } from "./checkpoint-store.js";
import { upstashSandboxInstanceStore } from "./instance-store.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

// TanStack AI's own sandbox store conformance suites, run against a real Upstash Redis. Every case
// gets a fresh keyspace: the suites use fixed thread ids and assume an empty store.
describe.skipIf(!hasRedisCreds)("sandbox stores (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tsb");
  let n = 0;
  const next = () => `${prefix}:${++n}`;

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  runSandboxInstanceStoreConformance("upstashSandboxInstanceStore", () =>
    upstashSandboxInstanceStore({ redis, prefix: next() }),
  );

  runSandboxCheckpointStoreConformance("upstashSandboxCheckpointStore", (options) =>
    upstashSandboxCheckpointStore({ redis, prefix: next(), ...options }),
  );

  // The fork writes the transcript into `upstashPersistence()`'s message store on the same prefix.
  runSandboxCheckpointForkConformance("upstashSandboxCheckpointStore", () => {
    const p = next();
    const checkpoints = upstashSandboxCheckpointStore({ redis, prefix: p });
    const fork = checkpoints.forkFromCheckpoint.bind(checkpoints);
    return {
      persistence: upstashPersistence({ redis, prefix: p }),
      checkpoints: {
        ...checkpoints,
        // The suite creates the fork promise, then reads the destination over the network, and only
        // then attaches `expect(...).rejects`. Against a real Redis the rejection lands in between,
        // and vitest reports it as unhandled. A no-op handler marks it handled; the suite still
        // receives (and asserts on) the same rejected promise.
        forkFromCheckpoint: (input) => {
          const promise = fork(input);
          promise.catch(() => {});
          return promise;
        },
      },
    };
  });

  // Sandbox durability stores its driver fields on the run record: check `upstashPersistence()`'s
  // run store keeps (and clears) them, since sandbox runs reuse it.
  runDurableRunFieldsConformance(
    "upstashPersistence runs",
    () => upstashPersistence({ redis, prefix: next() }).stores.runs,
  );

  it("refuses a fork into a thread that already has persisted runs", async () => {
    const p = next();
    const persistence = upstashPersistence({ redis, prefix: p });
    const checkpoints = upstashSandboxCheckpointStore({ redis, prefix: p });
    const source = await checkpoints.acquireWriter("src");
    await checkpoints.append({
      checkpoint: {
        id: "root",
        threadId: "src",
        parentCheckpointId: null,
        createdAt: 1,
        reason: "named",
        files: [],
        conversation: [{ role: "user", content: "hi" }],
        artifacts: [],
      },
      expectedHeadId: null,
      writer: source,
    });
    await persistence.stores.runs.createOrResume({
      runId: "r1",
      threadId: "dst",
      status: "running",
      startedAt: 1,
    } as never);
    const writer = await checkpoints.acquireWriter("dst");
    await expect(
      checkpoints.forkFromCheckpoint({
        sourceThreadId: "src",
        sourceCheckpointId: "root",
        destinationThreadId: "dst",
        destinationCheckpointId: "fork",
        createdAt: 2,
        writer,
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_SNAPSHOT_FORK_DESTINATION_NOT_EMPTY" });
    expect(await checkpoints.getHead("dst")).toBeNull();
  });

  it("keeps numeric-looking checkpoint ids as strings", async () => {
    const checkpoints = upstashSandboxCheckpointStore({ redis, prefix: next() });
    const writer = await checkpoints.acquireWriter("t");
    const base = {
      threadId: "t",
      reason: "automatic" as const,
      files: [],
      conversation: [],
      artifacts: [],
    };
    await checkpoints.append({
      checkpoint: { ...base, id: "007", parentCheckpointId: null, createdAt: 1 },
      expectedHeadId: null,
      writer,
    });
    expect(await checkpoints.getHead("t")).toBe("007");
    expect((await checkpoints.list("t")).map((c) => c.id)).toEqual(["007"]);
  });
});
