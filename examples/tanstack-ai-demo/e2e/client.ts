/** A small AG-UI-over-SSE client for the E2E suite: what `useChat` does, without a browser. */
import { randomUUID } from "node:crypto";

export interface Event {
  /** The SSE `id:` — the resume offset of this chunk in the run's durable log. */
  id?: string;
  chunk: { type: string; delta?: string; [key: string]: unknown };
}

export interface Turn {
  threadId: string;
  runId: string;
  text: string;
  user?: string;
}

export function newTurn(text: string, init: Partial<Turn> = {}): Turn {
  return { threadId: `thread-${randomUUID()}`, runId: `run-${randomUUID()}`, text, ...init };
}

/** POST a user message; returns the SSE response (the run keeps going if it is dropped). */
export function send(base: string, turn: Turn, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(turn.user ? { "x-demo-user": turn.user } : {}),
    },
    body: JSON.stringify({
      threadId: turn.threadId,
      runId: turn.runId,
      messages: [{ id: `msg-${randomUUID()}`, role: "user", content: turn.text }],
      tools: [],
      context: [],
    }),
    ...(signal ? { signal } : {}),
  });
}

/** Resume a run from an offset, the way a reloaded browser does (`Last-Event-ID`). */
export function resume(base: string, offset: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    headers: { "last-event-id": offset },
    ...(signal ? { signal } : {}),
  });
}

/** What `useChat` fetches on mount: the transcript plus the run still in flight, if any. */
export async function reconstruct(
  base: string,
  threadId: string,
): Promise<{
  messages: Array<{ role: string; parts: Array<{ type: string; content?: string }> }>;
  activeRun: { runId: string } | null;
}> {
  const res = await fetch(`${base}/api/chat?threadId=${encodeURIComponent(threadId)}`);
  if (!res.ok) throw new Error(`reconstruct failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Read SSE events from a response. Stops at the end of the stream, or after `stopAfter` returns
 * true (then the caller aborts the request, like a closed tab).
 */
export async function readEvents(
  res: Response,
  stopAfter?: (events: Event[]) => boolean,
): Promise<Event[]> {
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status} ${await res.text()}`);
  const events: Event[] = [];
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
      let id: string | undefined;
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      events.push({ ...(id ? { id } : {}), chunk: JSON.parse(data) });
      if (stopAfter?.(events)) {
        await reader.cancel().catch(() => undefined);
        return events;
      }
    }
  }
  return events;
}

export const textOf = (events: Event[]) =>
  events
    .filter((e) => e.chunk.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => e.chunk.delta ?? "")
    .join("");

export const assistantText = (thread: Awaited<ReturnType<typeof reconstruct>>) =>
  thread.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.content ?? "").join(""))
    .join("\n");

export async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    value = await read();
  }
  return value;
}
