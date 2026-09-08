/**
 * Where QStash delivers a task — and, once retries are exhausted, its failure callback.
 *
 * One line, because everything that has to be right here belongs to the transport: verifying the
 * signature, reading the task id, telling a delivery from a failure callback, and choosing the
 * status code that decides whether QStash tries again.
 */
import { tasks } from "../../lib/qstash-server";

export const dynamic = "force-dynamic";
// The demo tool sleeps ~10s and must finish inside this one invocation. That limit is the reason
// the workflow server exists.
export const maxDuration = 60;

export const POST = tasks.createExecuteHandler();
