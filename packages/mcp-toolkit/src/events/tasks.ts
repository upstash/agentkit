/**
 * A `task.finished` event, fired once when a task settles, to its owner only:
 *
 * ```ts
 * const taskFinished = taskFinishedEvent(events);
 * const tasks = createTaskLayer({ store, dispatcher, principal, onSettle: taskFinished.onSettle });
 * ```
 *
 * A host subscribes with no arguments for every task its user starts, or with a `taskId`.
 */
import * as z from "zod";
import type { Task } from "../tasks/types.js";
import { EventPayloadTooLargeError, type EventLayer } from "./core.js";

const taskFinishedInput = z.object({
  taskId: z
    .string()
    .optional()
    .describe("Only this task. Omit to hear about every task you start."),
});

const taskFinishedPayload = z.object({
  taskId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  statusMessage: z.string().optional(),
  /** The tool result, when it fits in the 256 KiB envelope. Otherwise call `task_status`. */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

export type TaskFinishedPayload = z.output<typeof taskFinishedPayload>;

export function taskFinishedEvent(
  events: EventLayer,
  options: { name?: string; description?: string } = {},
) {
  const event = events.define(options.name ?? "task.finished", {
    description:
      options.description ??
      "A long-running task you started finished: completed, failed or was cancelled. Carries the result when it is small enough.",
    input: taskFinishedInput,
    payload: taskFinishedPayload,
  });

  async function onSettle(task: Task): Promise<void> {
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
      return;
    }
    const payload: TaskFinishedPayload = {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      ...(task.result ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
    const emitOptions = {
      owner: task.owner,
      args: { taskId: task.taskId },
      // Stable, so a repeated settle hook cannot deliver twice.
      eventId: `evt_task_${task.taskId}`,
    };
    try {
      await event.emit(payload, emitOptions);
    } catch (error) {
      if (!(error instanceof EventPayloadTooLargeError)) throw error;
      // Too big to inline: send the outcome, and let the host fetch the result with task_status.
      const { result: _dropped, ...withoutResult } = payload;
      await event.emit(withoutResult, emitOptions);
    }
  }

  return { event, onSettle };
}
