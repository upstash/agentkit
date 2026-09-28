/**
 * The chat endpoint — TanStack AI's "persistent chat" pattern, on Upstash instead of in-memory
 * stores, so it works across server instances:
 *
 * - POST starts the model run **detached from the request** and answers by tailing the run's
 *   durable log. Closing the tab doesn't stop the run; it finishes, and is persisted.
 * - GET with `Last-Event-ID` / `?offset` resumes a run from the log — on any instance.
 * - GET with `?threadId` rebuilds the thread (`reconstructChat`): the transcript plus a pointer to
 *   the run still in flight, which the client then tails.
 */
import {
  EventType,
  chat,
  chatParamsFromRequest,
  chatParamsFromRequestBody,
  maxIterations,
  resumeServerSentEventsResponse,
} from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { memoryMiddleware } from "@tanstack/ai-memory";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { backends, runLog } from "@/lib/backends";
import { chatModel } from "@/lib/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatParams = Awaited<ReturnType<typeof chatParamsFromRequestBody>>;

/**
 * The user a request belongs to. A demo stand-in: a real app takes this from its auth session,
 * never from something the client can set — it is what keeps one user's memories from another's.
 */
function userIdOf(request: Request): string {
  return request.headers.get("x-demo-user") || "demo-user";
}

async function startDetachedRun(params: ChatParams, userId: string): Promise<void> {
  // One producer per run across every instance. A duplicate POST (a client retry that lands on
  // another server) just tails the log the first one is writing.
  const { persistence, memory, producerLock } = backends();
  const lease = await producerLock.tryAcquire(params.runId);
  if (!lease) return;

  const log = runLog({ runId: params.runId });
  const stream = chat({
    adapter: chatModel(),
    middleware: [
      withPersistence(persistence, { snapshotStreaming: true }),
      memoryMiddleware({ adapter: memory, scope: { threadId: params.threadId, userId } }),
    ],
    agentLoopStrategy: maxIterations(5),
    systemPrompts: ["You are a concise, friendly assistant."],
    messages: params.messages,
    threadId: params.threadId,
    runId: params.runId,
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
  });

  void (async () => {
    try {
      for await (const chunk of stream) await log.append([chunk]);
    } catch (error) {
      await log.append([
        {
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        } as StreamChunk,
      ]);
    } finally {
      await log.close();
      await lease.release();
    }
  })();
}

export async function POST(request: Request): Promise<Response> {
  let params: ChatParams;
  try {
    params = await chatParamsFromRequest(request);
  } catch (error) {
    // A malformed body throws a 400 Response; Next.js route handlers don't return thrown ones.
    if (error instanceof Response) return error;
    throw error;
  }
  await startDetachedRun(params, userIdOf(request));
  // Answer by reading the run's log from the start; the run itself is not tied to this response.
  return resumeServerSentEventsResponse({ adapter: runLog({ runId: params.runId, offset: "-1" }) });
}

export async function GET(request: Request): Promise<Response> {
  const log = runLog(request);
  if (log.resumeFrom() !== null) return resumeServerSentEventsResponse({ adapter: log });
  return reconstructChat(backends().persistence, request, {
    // A real app checks that the session's user may read this thread.
    authorize: (threadId) => threadId.length > 0,
  });
}
