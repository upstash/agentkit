import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import type { PersistenceConformanceCheck } from "@tanstack/ai-persistence/testkit";
import type { BlobStore } from "@tanstack/ai-persistence";
import { Bucket } from "@upstash/blob";
import { upstashPersistence } from "./persistence.js";
import { testBucket, type TestBucket } from "../testing/test-bucket.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

// Every opt-in check the kit offers (as of @tanstack/ai-persistence 0.7.1); none is skipped.
const OPT_IN_CHECKS: PersistenceConformanceCheck[] = [
  "messages.metadata",
  "runs.listByThread.state",
];

const hasBlobToken = Boolean(process.env.UPSTASH_BLOB_TOKEN);

// TanStack AI's own backend conformance suite, run against a real Upstash Redis, with every store
// present and none skipped: messages, runs, interrupts, metadata, generationRuns, artifacts, blobs.
// Blob bytes go to a stand-in bucket whose signed URLs are served over real HTTP with Range support.
describe.skipIf(!hasRedisCreds)("upstashPersistence (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tsp");
  let bucket: TestBucket;

  beforeAll(async () => {
    bucket = await testBucket();
  });

  afterAll(async () => {
    await bucket.close();
    await cleanupKeys(redis, prefix);
  });

  let n = 0;
  runPersistenceConformance(
    "upstashPersistence",
    // A fresh keyspace per case: the suite assumes each persistence starts empty.
    () =>
      upstashPersistence({ redis, prefix: `${prefix}:${++n}`, bucket, blobPathPrefix: `t/${n}/` }),
    { checks: OPT_IN_CHECKS },
  );

  it("serves byte ranges with an HTTP Range request, and cleans up bucket objects on delete", async () => {
    const { blobs } = upstashPersistence({
      redis,
      prefix: `${prefix}:range`,
      bucket,
      blobPathPrefix: "r/",
    }).stores;
    await blobs!.put("video.bin", "0123456789", { contentType: "application/octet-stream" });
    const before = bucket.rangeHits;
    const slice = await blobs!.get("video.bin", { range: { offset: 3, length: 4 } });
    expect(await slice!.text()).toBe("3456");
    expect(slice!.range).toEqual({ offset: 3, length: 4 });
    expect(bucket.rangeHits).toBe(before + 1);
    const version = (p: string) => p.startsWith("r/video.bin/");
    expect(bucket.paths().filter(version)).toHaveLength(1);
    await blobs!.delete("video.bin");
    expect(bucket.paths().filter(version)).toHaveLength(0);
    expect(await blobs!.head("video.bin")).toBeNull();
  });

  it("concurrent puts of one key never leave a record describing another writer's bytes", async () => {
    const { blobs } = upstashPersistence({
      redis,
      prefix: `${prefix}:race`,
      bucket,
      blobPathPrefix: "race/",
    }).stores;
    const bodies = ["a", "bb", "ccc", "dddd", "eeeee"];
    await Promise.all(bodies.map((body) => blobs!.put("k", body)));
    const got = await blobs!.get("k");
    const text = await got!.text();
    expect(bodies).toContain(text);
    expect(got!.size).toBe(text.length); // record and bytes are the same version
    // Every replaced version was cleaned up: exactly one object remains for the key.
    expect(bucket.paths().filter((p) => p.startsWith("race/k/"))).toHaveLength(1);
  });

  it("deleting an artifact while it is re-saved elsewhere leaves no dangling index entry", async () => {
    const { artifacts } = upstashPersistence({ redis, prefix: `${prefix}:artdel` }).stores;
    const base = { artifactId: "x", name: "n", mimeType: "text/plain", size: 1, createdAt: 1 };
    await artifacts.save({ ...base, runId: "r1", threadId: "t1" });
    await Promise.all([
      artifacts.delete("x"),
      artifacts.save({ ...base, runId: "r2", threadId: "t2" }),
    ]);
    const record = await artifacts.get("x");
    const listed = [
      ...(await artifacts.list("r1")),
      ...(await artifacts.list("r2")),
      ...(await artifacts.listForThread("t1")),
      ...(await artifacts.listForThread("t2")),
    ];
    if (record) {
      // The save won: it is indexed exactly where the record says.
      expect(listed.map((a) => a.runId + "/" + a.threadId)).toEqual(["r2/t2", "r2/t2"]);
    } else {
      // The delete won: nothing points at it anywhere.
      expect(listed).toEqual([]);
      expect(await redis.zcard(`${prefix}:artdel:runArtifacts:r2`)).toBe(0);
    }
  });

  it("get never reports a live key missing when an overwrite deletes the version it was reading", async () => {
    // A bucket whose first read of the original version is preceded by a concurrent overwrite, which
    // commits a new version and deletes the one this get had just resolved.
    let raced = false;
    let blobs: BlobStore;
    const racingBucket: typeof bucket = {
      ...bucket,
      put: bucket.put.bind(bucket),
      del: bucket.del.bind(bucket),
      get: async (path: string) => {
        if (!raced && path.startsWith("racy/k/")) {
          raced = true;
          await blobs.put("k", "second");
        }
        return bucket.get(path);
      },
    } as typeof bucket;
    blobs = upstashPersistence({
      redis,
      prefix: `${prefix}:racy`,
      bucket: racingBucket,
      blobPathPrefix: "racy/",
    }).stores.blobs!;
    await blobs.put("k", "first");
    const got = await blobs.get("k");
    expect(raced).toBe(true);
    expect(got).not.toBeNull();
    expect(await got!.text()).toBe("second");
  });

  it("omits the blobs store when no bucket is given", () => {
    const stores = upstashPersistence({ redis, prefix: `${prefix}:nob` }).stores;
    expect(stores.blobs).toBeUndefined();
    expect(stores.generationRuns).toBeDefined();
    expect(stores.artifacts).toBeDefined();
  });
});

// The same suite against a real Upstash Blob bucket. Needs UPSTASH_BLOB_TOKEN (skipped without it).
describe.skipIf(!hasRedisCreds || !hasBlobToken)(
  "upstashPersistence (live Redis + live Upstash Blob)",
  () => {
    const redis = testRedis();
    const prefix = uniquePrefix("tspblob");
    const bucket = hasBlobToken ? Bucket.fromEnv() : (undefined as never);
    const pathPrefix = `agentkit-test/${prefix.replace(/:/g, "-")}/`;

    afterAll(async () => {
      await cleanupKeys(redis, prefix);
      await bucket.del({ prefix: pathPrefix, all: true }).catch(() => undefined);
    });

    let n = 0;
    runPersistenceConformance(
      "upstashPersistence + Upstash Blob",
      () =>
        upstashPersistence({
          redis,
          prefix: `${prefix}:${++n}`,
          bucket,
          blobPathPrefix: `${pathPrefix}${n}/`,
        }),
      { checks: OPT_IN_CHECKS },
    );
  },
);

// Every Lua script runs with `allow-key-locking`, under which touching an undeclared key is an error.
// These drive the two paths whose key sets vary: a run with a parent index, and an artifact moved
// between runs and threads (whose old indexes must be declared, not read inside the script).
describe.skipIf(!hasRedisCreds)("key-locking scripts (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tskl");
  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("creates runs with and without a parent index", async () => {
    const { runs } = upstashPersistence({ redis, prefix }).stores;
    await runs.createOrResume({ runId: "p", threadId: "t", startedAt: 1 });
    await runs.createOrResume({
      runId: "c",
      threadId: "subagent:c",
      startedAt: 2,
      parentRunId: "p",
    });
    expect((await runs.listByParentRun!("p")).map((r) => r.runId)).toEqual(["c"]);
    expect(await redis.exists(`${prefix}:parentRuns:_`)).toBe(0);
  });

  it("moves a re-saved artifact between run and thread indexes", async () => {
    const { artifacts } = upstashPersistence({ redis, prefix }).stores;
    const base = {
      artifactId: "a1",
      name: "img.png",
      mimeType: "image/png",
      size: 3,
      createdAt: 5,
    };
    await artifacts.save({ ...base, runId: "r1", threadId: "t1" });
    await artifacts.save({ ...base, runId: "r2", threadId: "t2" });
    expect(await artifacts.list("r1")).toEqual([]);
    expect(await artifacts.listForThread("t1")).toEqual([]);
    expect((await artifacts.list("r2")).map((a) => a.artifactId)).toEqual(["a1"]);
    expect((await artifacts.listForThread("t2")).map((a) => a.runId)).toEqual(["r2"]);
  });

  it("concurrent saves of one artifact settle on a single indexed copy", async () => {
    const { artifacts } = upstashPersistence({ redis, prefix }).stores;
    const base = { artifactId: "a2", name: "x", mimeType: "text/plain", size: 1, createdAt: 1 };
    await Promise.all(
      ["ra", "rb", "rc"].map((runId) => artifacts.save({ ...base, runId, threadId: `t-${runId}` })),
    );
    const where = await Promise.all(["ra", "rb", "rc"].map((r) => artifacts.list(r)));
    expect(where.flat()).toHaveLength(1);
    const final = (await artifacts.get("a2"))!;
    expect((await artifacts.listForThread(final.threadId)).map((a) => a.artifactId)).toEqual([
      "a2",
    ]);
  });
});
