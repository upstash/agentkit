import { describe, expect, it } from "vitest";
import { DONE_MESSAGE, decodeMessage, encodeMessage, splitMessage } from "./codec.js";

const bytes = (piece: string) => Buffer.byteLength(encodeMessage(piece));

describe("codec", () => {
  it("round-trips text through the envelope, parsed or raw", () => {
    for (const text of ["", "42", "null", 'data: {"a":1}\n\n', DONE_MESSAGE]) {
      expect(encodeMessage(text)).not.toContain("\n");
      expect(decodeMessage(encodeMessage(text))).toBe(text);
      expect(decodeMessage(JSON.parse(encodeMessage(text)))).toBe(text);
    }
  });

  it("splits into pieces that fit, join back and keep surrogate pairs", () => {
    const message = 'data: "é日😀"\n\n\u0001'.repeat(2000);
    const pieces = splitMessage(message, 512);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(message);
    for (const piece of pieces) {
      expect(bytes(piece)).toBeLessThanOrEqual(512);
      expect(() => encodeURIComponent(piece)).not.toThrow();
    }
  });

  it("never produces a piece equal to DONE", () => {
    // 184 bytes of "a" fill a 200-byte piece exactly, so DONE would be a piece of its own.
    for (const message of ["a".repeat(184) + DONE_MESSAGE, "a".repeat(184) + DONE_MESSAGE + "b"]) {
      const pieces = splitMessage(message, 200);
      expect(pieces).not.toContain(DONE_MESSAGE);
      expect(pieces.join("")).toBe(message);
      for (const piece of pieces) expect(bytes(piece)).toBeLessThanOrEqual(200);
    }
  });
});
