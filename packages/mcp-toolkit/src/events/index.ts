/**
 * `@upstash/mcp-toolkit/events` — MCP Events (webhook delivery) for servers on the official
 * TypeScript SDK.
 *
 * The core here is storage-agnostic. The Upstash Redis + QStash backends live behind the
 * `@upstash/mcp-toolkit/events/upstash` entry point.
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
  type EmitResult,
  type EventConfig,
  type EventDescriptor,
  type EventHandle,
  type EventInputSchema,
  type EventLayer,
  type EventLayerOptions,
} from "./core.js";

export type {
  DeliveryEndpoints,
  DeliveryJob,
  EventDelivery,
  EventEnvelope,
  SendOutcome,
  Subscription,
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

export { SDK_TELEMETRY } from "../telemetry.js";
export { VERSION } from "../version.js";
