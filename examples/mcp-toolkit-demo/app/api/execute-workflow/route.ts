/**
 * Where Upstash Workflow runs each step of a task.
 *
 * Also one line — but this endpoint is called once *per step*, so no single invocation has to
 * cover the whole task and `maxDuration` bounds a step rather than the work.
 */
import { tasks } from "../../lib/workflow-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = tasks.createExecuteHandler();
