/**
 * `@upstash/mcp-toolkit/events`: MCP Events (webhook delivery) for servers on the official
 * TypeScript SDK, with the Upstash backends and in-memory ones for tests. Needs `@upstash/redis`
 * and `@upstash/qstash` installed.
 */
export {
  createEventLayer,
  canonicalJson,
  matchKeys,
  subscriptionId,
  EventPayloadTooLargeError,
  CALLBACK_ENDPOINT_ERROR,
  MAX_PAYLOAD_BYTES,
  type CallerAuth,
  type EmitOptions,
  type EmitRecipients,
  type EmitResult,
  type EventConfig,
  type EventDescriptor,
  type EventHandle,
  type EventInputSchema,
  type EventLayer,
  type EventLayerOptions,
} from "./core.js";

export type { PrincipalResolver } from "../shared/auth.js";

export type {
  DeliveryEndpoints,
  DeliveryJob,
  EventDelivery,
  EventEnvelope,
  SendOutcome,
  Subscription,
  SubscriptionRef,
  SubscriptionStore,
} from "./types.js";

export {
  signWebhook,
  verifyWebhook,
  decodeSecret,
  callbackUrlProblem,
  SecretBox,
} from "./webhooks.js";
export { taskFinishedEvent, type TaskFinishedPayload } from "./tasks.js";
export { InlineDelivery, MemorySubscriptionStore } from "./backends/memory.js";
export {
  RedisSubscriptionStore,
  QStashDelivery,
  DEFAULT_EVENTS_PREFIX,
  type RedisSubscriptionStoreConfig,
  type QStashDeliveryConfig,
} from "./backends/qstash.js";

export { SDK_TELEMETRY } from "../telemetry.js";
export { VERSION } from "../version.js";
