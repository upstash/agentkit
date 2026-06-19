import { AgentMemory } from "@upstash/agentkit-sdk";
import { MemorySearchStore } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryHooks } from "./memory.js";

describe("createMemoryHooks", () => {
  let memory: AgentMemory;

  beforeEach(() => {
    const search = new MemorySearchStore();
    memory = new AgentMemory({ search });
  });

  it("remembers then recalls, formatting a context block", async () => {
    const hooks = createMemoryHooks({ memory, scope: "user-1" });
    await hooks.remember("The user prefers TypeScript over JavaScript");

    const context = await hooks.recall("which programming language does the user prefer");
    expect(context).toContain("Relevant memories:");
    expect(context).toContain("- The user prefers TypeScript over JavaScript");
  });

  it("returns an empty string when nothing is recalled", async () => {
    const hooks = createMemoryHooks({ memory, scope: "empty-scope" });
    const context = await hooks.recall("anything at all");
    expect(context).toBe("");
  });

  it("isolates memories by scope", async () => {
    const a = createMemoryHooks({ memory, scope: "scope-a" });
    const b = createMemoryHooks({ memory, scope: "scope-b" });
    await a.remember("alpha secret detail");

    const fromB = await b.recall("alpha secret detail");
    expect(fromB).toBe("");
  });

  it("supports a custom header", async () => {
    const hooks = createMemoryHooks({ memory, scope: "user-2", header: "What I know:" });
    await hooks.remember("favorite color is blue");
    const context = await hooks.recall("favorite color");
    expect(context.startsWith("What I know:")).toBe(true);
  });
});
