import type { Embedder } from "../types.js";

/**
 * A deterministic, offline {@link Embedder} for tests. It produces a fixed-dimension bag-of-words
 * vector by hashing tokens into buckets, so texts that share words map to similar vectors and cosine
 * similarity behaves intuitively — without any network call or real model.
 */
export class MockEmbedder implements Embedder {
  readonly model = "mock-embedder";
  private dim: number;

  constructor(opts: { dim?: number } = {}) {
    this.dim = opts.dim ?? 64;
  }

  /** Synchronous single-text embedding, handy for {@link MemoryVectorStore}'s `embed` option. */
  embedOne = (text: string): number[] => {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const bucket = hashToken(tok) % this.dim;
      vec[bucket] = (vec[bucket] ?? 0) + 1;
    }
    // L2 normalize so cosine similarity is stable regardless of length.
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return vec.map((x) => x / norm);
  };

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(this.embedOne);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
