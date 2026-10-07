/**
 * The bridge between the two halves of the toolkit: a `task.finished` event fired when a task
 * settles, so a host that supports MCP Events can stop polling `task_status`.
 *
 * ```ts
 * const events = createEventLayer({ store, delivery });
 * const taskFinished = taskFinishedEvent(events);
 * const tasks = createTaskLayer({ store, dispatcher, onSettle: taskFinished.onSettle });
 * ```
 *
 * A host subscribes with no arguments to hear about every task the caller starts, or with a
 * `taskId` for one task. Deliveries only go to subscriptions made by the task's owner.
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
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
      return;
    const payload: TaskFinishedPayload = {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      ...(task.result ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
    const emitOptions = {
      args: { taskId: task.taskId },
      // The settle hook can fire twice only if a store misbehaves; a stable id makes it harmless.
      eventId: `evt_task_${task.taskId}`,
      ...(task.owner === undefined || task.owner === null ? {} : { owner: String(task.owner) }),
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
