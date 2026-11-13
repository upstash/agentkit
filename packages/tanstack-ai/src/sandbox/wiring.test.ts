import { describe, expect, it } from "vitest";
import { createSandboxSnapshots } from "@tanstack/ai-sandbox";
import { Redis } from "@upstash/redis";
import type { BlobBucketLike } from "../persistence/blob-store.js";
import { upstashLocks } from "../locks/locks.js";
import { upstashPersistence } from "../persistence/persistence.js";
import { upstashSandboxCheckpointStore } from "./checkpoint-store.js";
import { upstashSandboxInstanceStore } from "./instance-store.js";

// The README's "everything on Upstash" snapshot wiring must keep type-checking against
// `createSandboxSnapshots`: persistence (messages + artifacts + blobs), checkpoints, instances, locks.
describe("sandbox snapshot wiring", () => {
  it("accepts every Upstash store where createSandboxSnapshots expects one", () => {
    const redis = new Redis({ url: "https://example.upstash.io", token: "t" });
    // Never called here: the bucket only has to have the shape `upstashPersistence` accepts.
    const bucket = {} as BlobBucketLike;
    const snapshots = createSandboxSnapshots({
      persistence: upstashPersistence({ redis, bucket }),
      checkpoints: upstashSandboxCheckpointStore({ redis }),
      instances: upstashSandboxInstanceStore({ redis }),
      locks: upstashLocks({ redis }),
    });
    expect(typeof snapshots.fork).toBe("function");
  });
});
