import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { after } from "next/server";
import {
  createResumableStreamContext,
  createStopSignal,
} from "@upstash/agentkit-resumable-stream";
import { readChat, saveMessages, setActiveStreamId } from "@/lib/chat-store";
import { chatModel } from "@/lib/model";

export const maxDuration = 60;

/** Generates an answer into a resumable stream. */
export async function POST(req: Request) {
  const { id, message }: { id: string; message: UIMessage } = await req.json();
  const messages = [...(await readChat(id)).messages, message];
  await saveMessages(id, messages); // also clears the previous activeStreamId

  const streamId = generateId();
  // Aborts the generation once the stop route is called for this stream, on any instance.
  const stop = createStopSignal(streamId);

  const result = streamText({
    model: chatModel(),
    messages: await convertToModelMessages(messages),
    abortSignal: stop.signal,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      generateMessageId: generateId,
      // Runs after a stop too (`isAborted`), so the partial answer is saved.
      onEnd: async ({ messages }) => {
        stop.dispose();
        await saveMessages(id, messages);
      },
    }),
    // A copy of the SSE stream goes to Upstash Redis, so a reload can resume it on any instance.
    async consumeSseStream({ stream }) {
      await createResumableStreamContext({ waitUntil: after }).createNewResumableStream(
        streamId,
        () => stream,
      );
      await setActiveStreamId(id, streamId);
    },
  });
}
