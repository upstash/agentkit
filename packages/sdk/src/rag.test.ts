import { afterAll, describe, expect, it } from "vitest";
import { chunkText, Rag } from "./rag.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("short text")).toEqual(["short text"]);
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text into overlapping chunks on word boundaries", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(words, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(c).not.toMatch(/^\s|\s$/);
    }
  });

  it("throws when overlap >= size", () => {
    expect(() => chunkText("x".repeat(50), { chunkSize: 10, chunkOverlap: 10 })).toThrow();
  });
});

describe.skipIf(!hasRedisCreds)("Rag (live Redis)", () => {
  const namespace = uniqueNamespace("rag");
  const rag = new Rag({ redis: testRedis(), namespace, chunkSize: 60, chunkOverlap: 10 });

  afterAll(async () => {
    try {
      await rag.searchIndex.drop();
    } catch {
      /* index may not exist */
    }
  });

  it("ingests documents into chunks and retrieves relevant ones", async () => {
    const chunks = await rag.ingest({
      id: "doc1",
      text: "Upstash Redis is a serverless database. It supports REST access over HTTP. Redis Search enables fuzzy retrieval for RAG pipelines.",
      metadata: { source: "docs" },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.id).toBe("doc1:0");
    await rag.searchIndex.waitIndexing();

    const results = await rag.retrieve("serverless database REST", { topK: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.text.toLowerCase()).toMatch(/serverless|database|rest/);
    expect(results[0]!.docId).toBe("doc1");
    expect(results[0]!.metadata).toEqual({ source: "docs" });
  });

  it("scopes retrieval to a single document with docId", async () => {
    await rag.ingest({ id: "alpha", text: "alpha content about kangaroos and wallabies" });
    await rag.ingest({ id: "beta", text: "beta content about kangaroos and koalas" });
    await rag.searchIndex.waitIndexing();

    const results = await rag.retrieve("kangaroos", { topK: 5, docId: "alpha" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.docId === "alpha")).toBe(true);
  });

  it("removes a document's chunks", async () => {
    const chunks = await rag.ingest({ id: "gone", text: "deletable content here" });
    await rag.searchIndex.waitIndexing();
    await rag.remove("gone", { chunkCount: chunks.length });
    await rag.searchIndex.waitIndexing();
    const results = await rag.retrieve("deletable content", { topK: 5 });
    expect(results.find((r) => r.docId === "gone")).toBeUndefined();
  });
});
