/**
 * The wire format between {@link createUpstashPublisher} and {@link createUpstashSubscriber}.
 *
 * Every message is published as a small JSON envelope, `{"d":"<text>"}`, for two reasons:
 *
 * - Upstash delivers SUBSCRIBE messages over Server-Sent Events, one `data:` line per message, and
 *   `@upstash/redis` splits the event stream on newlines. resumable-stream's chunks are SSE text
 *   themselves (and its DONE message is mostly newlines), so they cannot travel raw. JSON escapes
 *   every newline.
 * - `@upstash/redis` JSON-parses subscription messages by default, so a chunk such as `"42"` would
 *   reach the listener as the number 42. An envelope decodes to the same string either way.
 *
 * A message whose envelope would exceed the size limit is split into ordered pieces. The
 * resumable-stream listener enqueues every message it receives as-is, so the consumer reads the
 * same text, just in more chunks.
 */

/**
 * The message resumable-stream publishes to a listener when the producer finishes (`DONE_MESSAGE`
 * in its `runtime.ts`, not exported). The publisher flushes everything queued before it, and a
 * split never produces a piece equal to it.
 */
export const DONE_MESSAGE = "\n\n\nDONE_SENTINEL_hasdfasudfyge374%$%^$EDSATRTYFtydryrte\n";

/** Bytes of `{"d":""}`. */
const ENVELOPE_OVERHEAD = 8;
/** Head room so one code point can move between two pieces (the largest costs 6 bytes). */
const SLACK = 8;
/** The smallest `maxMessageBytes` that still leaves a useful piece. */
export const MIN_MESSAGE_BYTES = 64;

/** Wraps one piece of text in the envelope. */
export function encodeMessage(text: string): string {
  return JSON.stringify({ d: text });
}

/**
 * Unwraps a received message. Accepts both what `@upstash/redis` delivers by default (the parsed
 * envelope object) and the raw string (`automaticDeserialization: false`). Anything that is not an
 * envelope is passed through as text.
 */
export function decodeMessage(message: unknown): string {
  let value = message;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return message as string;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { d?: unknown }).d === "string"
  ) {
    return (value as { d: string }).d;
  }
  return typeof message === "string" ? message : JSON.stringify(message);
}

/** UTF-8 bytes that one code point takes inside a JSON string literal. */
function jsonCost(codePoint: number): number {
  if (codePoint < 0x20) {
    // \b \t \n \f \r have short escapes, the other control characters become \u00XX
    return codePoint === 8 ||
      codePoint === 9 ||
      codePoint === 10 ||
      codePoint === 12 ||
      codePoint === 13
      ? 2
      : 6;
  }
  if (codePoint === 0x22 || codePoint === 0x5c) return 2; // \" and \\
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6; // a lone surrogate becomes \uXXXX
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** UTF-8 byte length of a string, without allocating. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Splits `message` into the fewest ordered pieces whose envelopes each fit in `maxBytes` (UTF-8).
 * Pieces never split a surrogate pair, so each is valid text on its own, and no piece of a split
 * message equals {@link DONE_MESSAGE}. Joining the pieces gives back `message`.
 */
export function splitMessage(message: string, maxBytes: number): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes < MIN_MESSAGE_BYTES) {
    throw new RangeError(`maxMessageBytes must be at least ${MIN_MESSAGE_BYTES}, got ${maxBytes}`);
  }
  const budget = maxBytes - ENVELOPE_OVERHEAD - SLACK;
  // Every UTF-16 unit costs at most 6 bytes in the envelope, so short messages skip the scan.
  if (message.length * 6 <= budget) return [message];

  const pieces: string[] = [];
  let start = 0;
  let size = 0;
  let i = 0;
  while (i < message.length) {
    const codePoint = message.codePointAt(i) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    const cost = jsonCost(codePoint);
    if (size + cost > budget && i > start) {
      pieces.push(message.slice(start, i));
      start = i;
      size = 0;
    }
    size += cost;
    i += width;
  }
  pieces.push(message.slice(start));
  return pieces.length > 1 ? avoidDonePieces(pieces) : pieces;
}

/**
 * The listener closes the stream on a message equal to {@link DONE_MESSAGE}, so a piece of a split
 * message must never be one. DONE starts and ends with a newline, so moving that one character to
 * the neighbouring piece fixes it, within the {@link SLACK} the split left.
 */
function avoidDonePieces(pieces: string[]): string[] {
  for (let pass = 0; pass < pieces.length && pieces.includes(DONE_MESSAGE); pass++) {
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i] !== DONE_MESSAGE) continue;
      if (i + 1 < pieces.length) {
        pieces[i + 1] = DONE_MESSAGE.slice(-1) + pieces[i + 1];
        pieces[i] = DONE_MESSAGE.slice(0, -1);
      } else {
        pieces[i - 1] = pieces[i - 1] + DONE_MESSAGE.slice(0, 1);
        pieces[i] = DONE_MESSAGE.slice(1);
      }
    }
  }
  return pieces;
}
