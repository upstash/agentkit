import { afterAll, describe } from "vitest";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { upstashPersistence } from "./persistence.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

// TanStack AI's own backend conformance suite, run against a real Upstash Redis. Every store this
// package provides is exercised; the three it does not provide (generation runs, artifacts, blobs)
// are declared skipped so a store that silently goes missing still fails the suite.
describe.skipIf(!hasRedisCreds)("upstashPersistence (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tsp");

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  let n = 0;
  runPersistenceConformance(
    "upstashPersistence",
    // A fresh keyspace per case: the suite assumes each persistence starts empty.
    () => upstashPersistence({ redis, prefix: `${prefix}:${++n}` }),
    { skip: ["generationRuns", "artifacts", "blobs"] },
  );
});
