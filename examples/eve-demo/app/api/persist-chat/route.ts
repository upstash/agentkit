import { NextResponse } from "next/server";
import { createChatHistory } from "@upstash/agentkit-eve";

export const runtime = "nodejs";

// A single demo user; a real app derives this from the authenticated principal.
const USER = "eve-demo-user";

// Lazily build the history so `Redis.fromEnv()` runs at request time, not build time.
let history: ReturnType<typeof createChatHistory> | undefined;
const getHistory = () => (history ??= createChatHistory({ namespace: "demo:eve:chat" }));

/**
 * The browser posts the full `useEveAgent` snapshot here when a turn settles: `snapshot.data.messages`
 * is the assembled EveMessage[] (tool-call parts and all), and `snapshot.session` is the resume cursor.
 * Redis is the durable source of truth — eve's Workflow session store is pruned 1–30 days post-run.
 */
export async function POST(req: Request) {
  try {
    const { sessionId, messages, session } = (await req.json()) as {
      sessionId?: string;
      messages?: unknown[];
      session?: Record<string, unknown>;
    };
    if (!sessionId) return NextResponse.json({ error: "missing sessionId" }, { status: 400 });

    await getHistory().saveChat(USER, sessionId, (messages ?? []) as never, {
      ...(session ? { metadata: { session } } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
