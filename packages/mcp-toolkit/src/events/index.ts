/**
 * `@upstash/mcp-toolkit/events`: MCP Events (webhook delivery) for servers on the official
 * TypeScript SDK. The Upstash backends are in `@upstash/mcp-toolkit/upstash`.
 */
export {
  McpEvents,
  type McpEventsOptions,
  type AuthorizeCaller,
  type EventConfig,
  type EventHandle,
  type EventInputSchema,
} from "./core.js";

export type { Caller, PrincipalResolver } from "../shared/auth.js";

export type {
  DeliveryJob,
  EventDelivery,
  EventEnvelope,
  SendJob,
  Subscription,
  SubscriptionStore,
} from "./types.js";

export { verifyWebhook } from "./webhooks.js";
