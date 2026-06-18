import { createHash } from "node:crypto";
import type { Embedder, Logger, VectorQuery, VectorRecord } from "./types.js";

/** Deterministic, order-insensitive hash of an arbitrary JSON value. */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** JSON.stringify with object keys sorted recursively, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Cosine similarity between two equal-length vectors. Returns a value in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} !== ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Resolve text into a {@link VectorRecord} embedding payload. When an {@link Embedder} is given the
 * text is embedded up front; otherwise the raw `data` is passed through for the store to embed.
 */
export async function toVectorPayload(
  text: string,
  embedder?: Embedder,
): Promise<Pick<VectorRecord, "vector" | "data">> {
  if (embedder) {
    const [vector] = await embedder.embed([text]);
    return { vector };
  }
  return { data: text };
}

/** Resolve text into the query side of {@link VectorQuery}. */
export async function toQueryPayload(
  text: string,
  embedder?: Embedder,
): Promise<Pick<VectorQuery, "vector" | "data">> {
  if (embedder) {
    const [vector] = await embedder.embed([text]);
    return { vector };
  }
  return { data: text };
}

/** Build a namespaced Redis key from parts, skipping empty segments. */
export function key(...parts: (string | number | undefined | null)[]): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== "").join(":");
}

/** Current epoch milliseconds. Wrapped so tests can stay deterministic if needed. */
export function now(): number {
  return Date.now();
}

/** A logger that swallows everything. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
