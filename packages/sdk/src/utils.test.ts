import { describe, expect, it } from "vitest";
import { cosineSimilarity, key, stableHash, stableStringify } from "./utils.js";

describe("stableStringify / stableHash", () => {
  it("produces identical output regardless of key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableHash({ a: 1, b: [2, 3] })).toBe(stableHash({ b: [2, 3], a: 1 }));
  });

  it("distinguishes different values", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it("handles nested structures and primitives", () => {
    expect(stableStringify({ x: { y: [1, "two", null] } })).toBe('{"x":{"y":[1,"two",null]}}');
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for a zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/mismatch/);
  });
});

describe("key", () => {
  it("joins parts and drops empty segments", () => {
    expect(key("a", "", "b", undefined, "c")).toBe("a:b:c");
  });
});
