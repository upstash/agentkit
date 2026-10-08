/**
 * MCP Events for the QStash server: one `task.finished` event, so a host that supports events
 * (ChatGPT today) gets a signed webhook when a task settles instead of polling `task_status`.
 *
 * Subscriptions live in Redis with their signing secrets encrypted; each delivery is a QStash
 * message to `/api/events`, which signs and POSTs it to the host and lets QStash retry failures.
 */
import {
  createEventLayer,
  QStashDelivery,
  RedisSubscriptionStore,
  taskFinishedEvent,
} from "@upstash/mcp-toolkit/events";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";

export const events = createEventLayer({
  store: new RedisSubscriptionStore({ prefix: "mcp:events:" }),
  delivery: new QStashDelivery({ url: `${APP_URL}/api/events` }),
  // Generate a real one with `openssl rand -base64 32`; the fallback only exists so the demo boots.
  secretKey: process.env.MCP_EVENTS_SECRET_KEY ?? "mcp-toolkit-demo-only-secret-key",
  // The demo's own receiver runs on localhost. Never set this in production: it disables the
  // checks that stop a subscriber from pointing your server at internal addresses.
  allowInsecureCallbacks: /^http:\/\/(127\.0\.0\.1|localhost)/.test(APP_URL),
});

export const taskFinished = taskFinishedEvent(events);
