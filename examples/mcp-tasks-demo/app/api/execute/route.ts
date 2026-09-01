/**
 * The endpoint QStash delivers a task to.
 *
 * This is where the work actually runs — in a different request, and possibly a different process,
 * from the `tools/call` that created the task. That separation is the whole point: the process
 * that accepted the call can die without taking the work with it.
 *
 * The handler comes from the dispatcher rather than being written here, because everything it has
 * to get right belongs to the transport: verifying the QStash signature, reading the task id,
 * counting which attempt this is, and answering with the status code that decides whether QStash
 * tries again.
 */
import { tasks } from "../../lib/tasks";

export const dynamic = "force-dynamic";
// The demo tool sleeps for ~10s; give the platform room to let it finish.
export const maxDuration = 60;

export const POST = tasks.createExecuteHandler();
