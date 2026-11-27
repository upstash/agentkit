/**
 * Every message is published as `{"d":"<text>"}`: Upstash delivers SUBSCRIBE as Server-Sent
 * Events, which `@upstash/redis` splits on newlines (resumable-stream's chunks and its DONE message
 * are full of them), and it JSON-parses each message (`"42"` would arrive as the number 42).
 */

/** resumable-stream's DONE message (`runtime.ts`, not exported). */
export const DONE_MESSAGE = "\n\n\nDONE_SENTINEL_hasdfasudfyge374%$%^$EDSATRTYFtydryrte\n";

export const encodeMessage = (text: string): string => JSON.stringify({ d: text });

/** Accepts the parsed envelope (the client default) or the raw string. */
export function decodeMessage(message: unknown): string {
  let value = message;
  try {
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    return message as string;
  }
  const d = (value as { d?: unknown } | null)?.d;
  if (typeof d === "string") return d;
  return typeof message === "string" ? message : JSON.stringify(message);
}

/** UTF-8 bytes one code point takes inside a JSON string. */
function jsonBytes(c: number): number {
  if (c < 0x20) return [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
  if (c === 0x22 || c === 0x5c) return 2;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdfff) return 6; // lone surrogate, escaped
  return c < 0x10000 ? 3 : 4;
}

/**
 * Splits `message` into ordered pieces whose envelopes fit in `maxBytes`, without splitting a
 * surrogate pair. resumable-stream's listener enqueues each message as-is, so the reader gets the
 * same text in more chunks. A piece must never equal DONE (it would end the stream); DONE starts
 * and ends with a newline, so moving one character to the neighbour fixes it (16 bytes are kept
 * free for that and for the envelope).
 */
export function splitMessage(message: string, maxBytes: number): string[] {
  const budget = maxBytes - 16;
  if (message.length * 6 <= budget) return [message];
  const pieces: string[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < message.length; ) {
    const c = message.codePointAt(i) as number;
    if (size + jsonBytes(c) > budget && i > start) {
      pieces.push(message.slice(start, i));
      [start, size] = [i, 0];
    }
    size += jsonBytes(c);
    i += c > 0xffff ? 2 : 1;
  }
  pieces.push(message.slice(start));
  for (let i = 0; i < pieces.length && pieces.length > 1; i++) {
    if (pieces[i] !== DONE_MESSAGE) continue;
    if (i + 1 < pieces.length)
      [pieces[i], pieces[i + 1]] = [DONE_MESSAGE.slice(0, -1), "\n" + pieces[i + 1]];
    else [pieces[i - 1], pieces[i]] = [pieces[i - 1] + "\n", DONE_MESSAGE.slice(1)];
  }
  return pieces;
}
