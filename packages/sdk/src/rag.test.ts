import { beforeEach, describe, expect, it } from "vitest";
import { chunkText, Rag } from "./rag.js";
import { MemoryVectorStore } from "./testing/memory-vector-store.js";
import { MockEmbedder } from "./testing/mock-embedder.js";

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

describe("Rag", () => {
  let vector: MemoryVectorStore;
  let embedder: MockEmbedder;

  beforeEach(() => {
    embedder = new MockEmbedder();
    vector = new MemoryVectorStore();
  });

  it("ingests documents into chunks and retrieves relevant ones", async () => {
    const rag = new Rag({ vector, embedder, chunkSize: 60, chunkOverlap: 10 });
    const chunks = await rag.ingest({
      id: "doc1",
      text: "Upstash Redis is a serverless database. It supports REST access over HTTP. Vector search enables semantic retrieval for RAG pipelines.",
      metadata: { source: "docs" },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.id).toBe("doc1:0");

    const results = await rag.retrieve("semantic vector search retrieval", { topK: 2 });
    expect(results.length).toBeGreaterThan(0);
    // The most relevant chunk is about semantic retrieval / vector search.
    expect(results[0]!.text.toLowerCase()).toMatch(/semantic|vector|retrieval/);
    expect(results[0]!.docId).toBe("doc1");
    expect(results[0]!.metadata).toEqual({ source: "docs" });
    expect(results[0]!.score).toBeGreaterThan(results[1]?.score ?? -1);
  });

  it("removes a document's chunks", async () => {
    const rag = new Rag({ vector, embedder, chunkSize: 1000 });
    const chunks = await rag.ingest({ id: "doc2", text: "deletable content here" });
    await rag.remove("doc2", { chunkCount: chunks.length });
    const results = await rag.retrieve("deletable content", { topK: 5 });
    expect(results.find((r) => r.docId === "doc2")).toBeUndefined();
  });
});
