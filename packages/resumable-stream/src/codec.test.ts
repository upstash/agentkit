import { describe, expect, it } from "vitest";
import {
  DONE_MESSAGE,
  decodeMessage,
  encodeMessage,
  MIN_MESSAGE_BYTES,
  splitMessage,
  utf8Length,
} from "./codec.js";

const envelopeBytes = (piece: string) => Buffer.byteLength(encodeMessage(piece));

describe("encodeMessage / decodeMessage", () => {
  it("round-trips text with newlines, quotes and numbers-as-text", () => {
    for (const text of ["", "42", "true", 'data: {"a":1}\n\n', DONE_MESSAGE, "\u0000 "]) {
      const wire = encodeMessage(text);
      expect(wire).not.toContain("\n");
      // Raw string (automaticDeserialization: false) and parsed object (the default) both decode.
      expect(decodeMessage(wire)).toBe(text);
      expect(decodeMessage(JSON.parse(wire))).toBe(text);
    }
  });

  it("passes through messages that are not envelopes", () => {
    expect(decodeMessage("hello")).toBe("hello");
    expect(decodeMessage("123")).toBe("123");
    expect(decodeMessage(123)).toBe("123");
    expect(decodeMessage({ other: 1 })).toBe('{"other":1}');
  });
});

describe("utf8Length", () => {
  it("matches Buffer.byteLength", () => {
    for (const text of ["abc", "éè", "日本", "😀x", "\ud83d"]) {
      expect(utf8Length(text)).toBe(Buffer.byteLength(text));
    }
  });
});

describe("splitMessage", () => {
  it("keeps a message that fits in one piece", () => {
    expect(splitMessage("hello", 1024)).toEqual(["hello"]);
    expect(splitMessage("", 1024)).toEqual([""]);
  });

  it("rejects a limit below the minimum", () => {
    expect(() => splitMessage("x", MIN_MESSAGE_BYTES - 1)).toThrow(RangeError);
  });

  it.each([
    ["ascii", "data: hello world\n\n".repeat(500)],
    ["escapes", '"\\\n\t\u0001'.repeat(400)],
    ["multi-byte", "é日😀".repeat(700)],
    ["lone surrogates", "a\ud83d".repeat(500)],
  ])("splits %s text into pieces that fit and join back", (_, message) => {
    const max = 512;
    const pieces = splitMessage(message, max);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(message);
    for (const piece of pieces) expect(envelopeBytes(piece)).toBeLessThanOrEqual(max);
  });

  it("never splits a surrogate pair", () => {
    const message = "😀".repeat(1000);
    for (const piece of splitMessage(message, 100)) {
      expect(piece.length % 2).toBe(0);
      expect(() => encodeURIComponent(piece)).not.toThrow();
    }
  });

  it("never produces a piece equal to the DONE message", () => {
    // The budget is maxBytes - 16, so 184 bytes of "a" fill the first piece exactly and DONE
    // would be the whole second piece; likewise when DONE sits in the middle.
    const max = 200;
    for (const message of [
      "a".repeat(184) + DONE_MESSAGE,
      "a".repeat(184) + DONE_MESSAGE + "b".repeat(184),
    ]) {
      const pieces = splitMessage(message, max);
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces).not.toContain(DONE_MESSAGE);
      expect(pieces.join("")).toBe(message);
      for (const piece of pieces) expect(envelopeBytes(piece)).toBeLessThanOrEqual(max);
    }
  });
});
