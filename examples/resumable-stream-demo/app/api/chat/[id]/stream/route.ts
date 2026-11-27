import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream/generic";
import { createUpstashPublisher, createUpstashSubscriber } from "@upstash/agentkit-resumable-stream";
import { readChat } from "@/lib/chat-store";

/** `useChat({ resume: true })` calls this on mount: replays the active stream, if any. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { activeStreamId } = await readChat((await params).id);
  if (!activeStreamId) return new Response(null, { status: 204 });
  const streamContext = createResumableStreamContext({
    waitUntil: after,
    publisher: createUpstashPublisher(),
    subscriber: createUpstashSubscriber(),
  });
  const stream = await streamContext.resumeExistingStream(activeStreamId);
  if (!stream) return new Response(null, { status: 204 }); // finished or expired
  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
