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
import { LockAcquireTimeoutError } from "@upstash/agentkit-tanstack-ai";
import { after } from "next/server";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { backends, runLog } from "@/lib/backends";
import { chatModel } from "@/lib/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The longest a detached run may take on a serverless host (seconds). */
export const maxDuration = 300;

type ChatParams = Awaited<ReturnType<typeof chatParamsFromRequestBody>>;

/**
 * The user a request belongs to. A demo stand-in: a real app takes this from its auth session,
 * never from something the client can set — it is what keeps one user's memories from another's.
 */
function userIdOf(request: Request): string {
  return request.headers.get("x-demo-user") || "demo-user";
}

/**
 * Produce a run into its durable log — exactly once across every instance. Resolves when the run is
 * done, or right away when another instance already owns it (a client retry that landed on another
 * server just tails the log the first one is writing).
 *
 * The lock is a lease renewed for as long as the run lasts, so long runs stay single-producer. If
 * renewal ever reports the lease lost, the run is aborted and this producer stops touching the log,
 * since another instance may now own it.
 */
function produceRun(params: ChatParams, userId: string): Promise<void> {
  const { persistence, memory, producerLock } = backends();
  return producerLock
    .withLock(
      params.runId,
      async (leaseLost) => {
        const abortController = new AbortController();
        leaseLost.addEventListener("abort", () => abortController.abort(leaseLost.reason), {
          once: true,
        });
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
          abortController,
          ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
          ...(params.resume ? { resume: params.resume } : {}),
        });
        try {
          for await (const chunk of stream) {
            if (leaseLost.aborted) return;
            await log.append([chunk]);
          }
        } catch (error) {
          if (leaseLost.aborted) return;
          await log.append([
            {
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
            } as StreamChunk,
          ]);
        } finally {
          if (!leaseLost.aborted) await log.close();
        }
      },
      // Don't wait: a held lock means the run is already being produced elsewhere.
      { acquireTimeoutMs: 0 },
    )
    .catch((error) => {
      if (error instanceof LockAcquireTimeoutError) return;
      throw error;
    });
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
  // Detached from this request: the run keeps going if the client leaves. `after` keeps the
  // invocation alive until it finishes (up to the platform's max duration), which is what makes this
  // safe on serverless; on a long-running server it is simply a background task.
  after(produceRun(params, userIdOf(request)));
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
