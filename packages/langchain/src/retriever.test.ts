import { afterAll, describe, expect, it } from "vitest";
import { AgentKitRetriever } from "./retriever.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("AgentKitRetriever (live Redis)", () => {
  const redis = testRedis();

  it("ingests LangChain documents and returns mapped documents", async () => {
    const namespace = uniqueNamespace("retriever-ingest");
    const retriever = new AgentKitRetriever({ redis, namespace, topK: 2, chunkSize: 1000 });
    try {
      await retriever.addDocuments([
        { pageContent: "Upstash Search enables fuzzy retrieval for RAG.", metadata: { src: "a" } },
        { pageContent: "Bananas are a yellow fruit grown in the tropics.", metadata: { src: "b" } },
      ]);
      await retriever.searchIndex.waitIndexing();

      const docs = await retriever.getRelevantDocuments("fuzzy search retrieval");
      expect(docs.length).toBeGreaterThan(0);
      const top = docs[0]!;
      expect(top.pageContent.toLowerCase()).toMatch(/fuzzy|search|retrieval/);
      // Mapped metadata carries through src plus retrieval bookkeeping.
      expect(top.metadata?.src).toBe("a");
      expect(typeof top.metadata?.score).toBe("number");
      expect(top.metadata?.index).toBe(0);
    } finally {
      await retriever.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("invoke() is an alias for getRelevantDocuments", async () => {
    const namespace = uniqueNamespace("retriever-invoke");
    const retriever = new AgentKitRetriever({ redis, namespace, topK: 1 });
    try {
      await retriever.addDocuments([{ pageContent: "serverless redis database engine" }]);
      await retriever.searchIndex.waitIndexing();

      const docs = await retriever.invoke("redis database");
      expect(docs.length).toBeGreaterThan(0);
      expect(docs[0]!.pageContent).toContain("redis");
    } finally {
      await retriever.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("returns no documents for an empty index", async () => {
    const namespace = uniqueNamespace("retriever-empty");
    const retriever = new AgentKitRetriever({ redis, namespace });
    try {
      expect(await retriever.invoke("anything")).toEqual([]);
    } finally {
      await retriever.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  afterAll(() => {
    // Per-test cleanup handles index/key teardown above.
  });
});
