import { describe, expect, it } from "vitest";
import { key, stableHash, stableStringify } from "./utils.js";

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

describe("key", () => {
  it("joins parts and drops empty segments", () => {
    expect(key("a", "", "b", undefined, "c")).toBe("a:b:c");
  });
});
