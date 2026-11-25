import { requestStop } from "@upstash/agentkit-resumable-stream";
import { readChat } from "@/lib/chat-store";

/**
 * Stops the active generation, whichever instance runs it: `requestStop` sets a flag that the
 * producer's `createStopSignal` picks up within a second. The producer then saves the partial
 * answer and clears `activeStreamId`, and every reader sees the stream end.
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { activeStreamId } = await readChat((await params).id);
  if (activeStreamId) await requestStop(activeStreamId);
  return new Response(null, { status: 204 });
}
