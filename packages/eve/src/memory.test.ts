import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryHooks } from "./memory.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("createMemoryHooks (live Redis)", () => {
  const memory = new AgentMemory({ redis: testRedis(), namespace: uniqueNamespace("eve-mem") });

  afterAll(async () => {
    await memory.searchIndex.drop().catch(() => {});
  });

  it("remembers then recalls, formatting a context block", async () => {
    const hooks = createMemoryHooks({ memory, scope: "user-1" });
    await hooks.remember("The user prefers TypeScript over JavaScript");
    await memory.searchIndex.waitIndexing();

    const context = await hooks.recall("which language does the user prefer");
    expect(context).toContain("Relevant memories:");
    expect(context).toContain("- The user prefers TypeScript over JavaScript");
  });

  it("returns an empty string when nothing is recalled", async () => {
    const hooks = createMemoryHooks({ memory, scope: "empty-scope" });
    const context = await hooks.recall("nothing stored under here at all");
    expect(context).toBe("");
  });

  it("isolates memories by scope", async () => {
    const a = createMemoryHooks({ memory, scope: "scope-a" });
    const b = createMemoryHooks({ memory, scope: "scope-b" });
    await a.remember("alpha secret detail kangaroo");
    await memory.searchIndex.waitIndexing();
    expect(await b.recall("alpha secret detail kangaroo")).toBe("");
  });

  it("supports a custom header", async () => {
    const hooks = createMemoryHooks({ memory, scope: "user-2", header: "What I know:" });
    await hooks.remember("favorite color is blue");
    await memory.searchIndex.waitIndexing();
    const context = await hooks.recall("favorite color");
    expect(context.startsWith("What I know:")).toBe(true);
  });
});
