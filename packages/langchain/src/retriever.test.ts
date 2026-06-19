import { MemorySearchStore } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentKitRetriever } from "./retriever.js";

describe("AgentKitRetriever", () => {
  let search: MemorySearchStore;

  beforeEach(() => {
    search = new MemorySearchStore();
  });

  it("ingests LangChain documents and returns mapped documents", async () => {
    const retriever = new AgentKitRetriever({ search, topK: 2, chunkSize: 1000 });
    await retriever.addDocuments([
      { pageContent: "Upstash Search enables fuzzy retrieval for RAG.", metadata: { src: "a" } },
      { pageContent: "Bananas are a yellow fruit grown in the tropics.", metadata: { src: "b" } },
    ]);

    const docs = await retriever.getRelevantDocuments("fuzzy search retrieval");
    expect(docs.length).toBeGreaterThan(0);
    const top = docs[0]!;
    expect(top.pageContent.toLowerCase()).toMatch(/fuzzy|search|retrieval/);
    // Mapped metadata carries through src plus retrieval bookkeeping.
    expect(top.metadata?.src).toBe("a");
    expect(typeof top.metadata?.score).toBe("number");
    expect(top.metadata?.index).toBe(0);
  });

  it("invoke() is an alias for getRelevantDocuments", async () => {
    const retriever = new AgentKitRetriever({ search, topK: 1 });
    await retriever.addDocuments([{ pageContent: "serverless redis database" }]);
    const docs = await retriever.invoke("redis database");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.pageContent).toContain("redis");
  });

  it("returns no documents for an empty index", async () => {
    const retriever = new AgentKitRetriever({ search });
    expect(await retriever.invoke("anything")).toEqual([]);
  });
});
