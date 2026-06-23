import { afterAll, describe, expect, it } from "vitest";
import { Rag } from "./rag.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("Rag (live Redis)", () => {
  const namespace = uniqueNamespace("rag");
  // The document data type flows through ingest()/retrieve() via the generic.
  const rag = new Rag<{ title: string; body: string }>({ redis: testRedis(), namespace });

  afterAll(async () => {
    try {
      await rag.searchIndex.drop();
    } catch {
      /* index may not exist */
    }
  });

  it("ingests an array of documents and retrieves relevant ones by their data", async () => {
    const stored = await rag.ingest([
      { id: "doc1", data: { title: "Upstash Redis", body: "a serverless database over HTTP" } },
      { id: "doc2", data: { title: "Redis Search", body: "fuzzy retrieval for RAG pipelines" } },
    ]);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.id).toBe("doc1");
    await rag.searchIndex.waitIndexing();

    const results = await rag.retrieve("serverless database", { topK: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe("doc1");
    expect(results[0]!.data).toEqual({
      title: "Upstash Redis",
      body: "a serverless database over HTTP",
    });
  });

  it("ingests a single document and generates an id when omitted", async () => {
    const [doc] = await rag.ingest({
      data: { title: "Marsupials", body: "kangaroos and wallabies" },
    });
    expect(doc!.id).toBeTruthy();
    await rag.searchIndex.waitIndexing();

    const results = await rag.retrieve("kangaroos", { topK: 5 });
    expect(results.some((r) => r.id === doc!.id)).toBe(true);
  });

  it("removes a document by id", async () => {
    await rag.ingest({ id: "gone", data: { title: "Temp", body: "deletable content here" } });
    await rag.searchIndex.waitIndexing();

    await rag.remove("gone");
    await rag.searchIndex.waitIndexing();

    const results = await rag.retrieve("deletable content", { topK: 5 });
    expect(results.find((r) => r.id === "gone")).toBeUndefined();
  });
});
