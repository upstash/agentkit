/** A small UI-message-stream-over-SSE client for the E2E suite: what `useChat` does, without a browser. */
import { randomUUID } from "node:crypto";

export interface Chunk {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

export const newChatId = () => `e2e-${randomUUID()}`;

/** POST a user message, as the demo's transport does (only the new message; the server has the rest). */
export function send(base: string, chatId: string, text: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      message: { id: `msg-${randomUUID()}`, role: "user", parts: [{ type: "text", text }] },
    }),
    ...(signal ? { signal } : {}),
  });
}

/** What `useChat({ resume: true })` fetches on mount: the active stream, or 204 without one. */
export function resume(base: string, chatId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/chat/${encodeURIComponent(chatId)}/stream`, {
    ...(signal ? { signal } : {}),
  });
}

/** What the Stop button calls: ends the generation on whichever instance runs it. */
export function stop(base: string, chatId: string): Promise<Response> {
  return fetch(`${base}/api/chat/${encodeURIComponent(chatId)}/stop`, { method: "POST" });
}

/**
 * Read UI message chunks from an SSE response. Stops at the end of the stream, or after
 * `stopAfter` returns true (then the caller aborts the request, like a closed tab).
 */
export async function readChunks(
  res: Response,
  stopAfter?: (chunks: Chunk[]) => boolean,
): Promise<Chunk[]> {
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status} ${await res.text()}`);
  const chunks: Chunk[] = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      chunks.push(JSON.parse(data));
      if (stopAfter?.(chunks)) {
        await reader.cancel().catch(() => undefined);
        return chunks;
      }
    }
  }
  return chunks;
}

export const textOf = (chunks: Chunk[]) =>
  chunks
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta ?? "")
    .join("");

export const deltaCount = (n: number) => (chunks: Chunk[]) =>
  chunks.filter((c) => c.type === "text-delta").length >= n;

export async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    value = await read();
  }
  return value;
}
