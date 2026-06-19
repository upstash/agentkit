import { createHash } from "node:crypto";
import type { Logger } from "./types.js";

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
