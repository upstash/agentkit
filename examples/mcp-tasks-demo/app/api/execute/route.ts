/**
 * The endpoint QStash delivers a task to.
 *
 * This is where the work actually runs — in a different request, and possibly a different process,
 * from the `tools/call` that created the task. That separation is the whole point: the process
 * that accepted the call can die without taking the work with it.
 */
import { Receiver } from "@upstash/qstash";
import { isFinalQStashAttempt } from "@upstash/mcp-tasks/upstash";
import { dispatcher, EXECUTE_URL, tasks } from "../../lib/tasks";

export const dynamic = "force-dynamic";
// The demo tool sleeps for ~10s; give the platform room to let it finish.
export const maxDuration = 60;

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY ?? "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY ?? "",
});

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  // Without this, anyone who can reach the route can run tasks.
  try {
    await receiver.verify({
      signature: request.headers.get("upstash-signature") ?? "",
      body,
      url: EXECUTE_URL,
    });
  } catch (cause) {
    console.error("[execute] signature verification failed", cause);
    // 401 is deliberate: a bad signature is not something a retry can fix.
    return new Response("invalid signature", { status: 401 });
  }

  const { taskId } = JSON.parse(body) as { taskId?: string };
  if (!taskId) return new Response("missing taskId", { status: 400 });

  // Whether a thrown handler is fatal depends on whether QStash will try again.
  const isFinalAttempt = isFinalQStashAttempt(request.headers, dispatcher.retries);

  try {
    console.log(`[execute] task=${taskId} starting (final attempt: ${isFinalAttempt})`);
    const task = await tasks.executeTask(taskId, { isFinalAttempt });
    console.log(`[execute] task=${taskId} -> ${task?.status ?? "gone"}`);
    return new Response("ok");
  } catch (cause) {
    console.error(`[execute] task=${taskId} failed`, cause);
    // A non-2xx is how you ask QStash to retry.
    return new Response("retry", { status: 500 });
  }
}
