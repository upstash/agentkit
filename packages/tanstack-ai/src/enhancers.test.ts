import { AgentMemory, SemanticCache } from "@upstash/agentkit-sdk";
import {
  MemoryRedis,
  MemoryVectorStore,
  MockEmbedder,
  MockModel,
} from "@upstash/agentkit-sdk/testing";
import { describe, expect, it } from "vitest";
import { withMemory, withSemanticCache } from "./enhancers.js";

describe("withSemanticCache", () => {
  it("serves a similar prompt from cache without calling the model", async () => {
    const embedder = new MockEmbedder();
    const vector = new MemoryVectorStore({ embed: embedder.embedOne });
    const cache = new SemanticCache({ vector, embedder, minScore: 0.5 });
    const model = new MockModel({ responses: ["Paris"] });

    const cached = withSemanticCache(model.generate, { cache });

    const first = await cached("What is the capital of France?");
    const second = await cached("What's the capital of France?");

    expect(first).toBe("Paris");
    expect(second).toBe("Paris");
    expect(model.callCount).toBe(1);
  });
});

describe("withMemory", () => {
  it("recalls memories and formats them as a context message", async () => {
    const embedder = new MockEmbedder();
    const vector = new MemoryVectorStore({ embed: embedder.embedOne });
    const memory = new AgentMemory({ vector, redis: new MemoryRedis(), embedder });

    await memory.add("The user prefers dark mode", { scope: "u1" });

    const injector = withMemory({ memory, scope: "u1", minScore: 0.1 });
    const context = await injector.recall("what mode does the user like");

    expect(context).not.toBeNull();
    expect(context?.role).toBe("system");
    expect(context?.content).toContain("dark mode");
  });

  it("returns null when nothing relevant is recalled", async () => {
    const embedder = new MockEmbedder();
    const vector = new MemoryVectorStore({ embed: embedder.embedOne });
    const memory = new AgentMemory({ vector, redis: new MemoryRedis(), embedder });

    const injector = withMemory({ memory, scope: "u1", minScore: 0.99 });
    const context = await injector.recall("unrelated topic with no stored memories");

    expect(context).toBeNull();
  });
});
