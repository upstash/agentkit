/**
 * The Upstash backends, in one place: Redis for the task record, and either QStash or Upstash
 * Workflow for the execution.
 *
 * The two dispatchers are not interchangeable, and the type system says so — see
 * {@link QStashDispatcher} and {@link WorkflowDispatcher} for which to pick.
 *
 * This is the only Upstash entry point, so it pulls in `@upstash/redis`, `@upstash/qstash` and
 * `@upstash/workflow`. All three are optional peers of the package, but an app importing from
 * here needs them installed.
 */
export {
  RedisTaskStore,
  QStashDispatcher,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY,
  DEFAULT_TASK_PREFIX,
  type RedisTaskStoreConfig,
  type QStashDispatcherConfig,
} from "./backends/qstash.js";

export { WorkflowDispatcher, type WorkflowDispatcherConfig } from "./backends/workflow.js";
