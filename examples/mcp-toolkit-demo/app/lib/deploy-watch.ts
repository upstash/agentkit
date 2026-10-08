/**
 * Deploy Watch: the **events** half of the demo, with no tasks in it.
 *
 * One event, `deploy.finished`, fired whenever a deploy is reported to `/api/deploy-watch/deploys`.
 * A host that supports MCP Events (ChatGPT today) subscribes to it, optionally filtered by service
 * or environment, and gets a signed webhook for every matching deploy. One plain tool,
 * `list_recent_deploys`, lets the agent look around when it wakes up.
 *
 * Subscriptions live in Redis with their signing secrets encrypted; each delivery is a QStash
 * message to `/api/deploy-watch/events`, which signs and POSTs it to the host and lets QStash retry.
 */
import { McpServer } from "@modelcontextprotocol/server";
import {
  createEventLayer,
  QStashDelivery,
  RedisSubscriptionStore,
} from "@upstash/mcp-toolkit/events";
import { Redis } from "@upstash/redis";
import * as z from "zod";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:3000";
const RECENT_KEY = "deploy-watch:recent";
/** The demo has no login, so every caller is this one user. A real server returns its user id. */
const DEMO_USER = "demo-user";

export const events = createEventLayer({
  store: new RedisSubscriptionStore({ prefix: "deploy-watch:events:" }),
  delivery: new QStashDelivery({ url: `${APP_URL}/api/deploy-watch/events` }),
  // `secretKey` is read from MCP_EVENTS_SECRET_KEY (see .env.example). There is no fallback.
  principal: () => DEMO_USER,
  // Logs what the host answers to the challenge and to every delivery.
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    const body = await response
      .clone()
      .text()
      .catch(() => "");
    console.log(`[deploy-watch] POST ${String(input).slice(0, 80)} -> ${response.status} ${body.slice(0, 200)}`);
    return response;
  },
  // The demo's own receiver runs on localhost. Never set this in production: it disables the
  // checks that stop a subscriber from pointing your server at internal addresses.
  allowInsecureCallbacks: /^http:\/\/(127\.0\.0\.1|localhost)/.test(APP_URL),
});

export const Deploy = z.object({
  id: z.string(),
  service: z.string(),
  environment: z.enum(["production", "staging"]),
  status: z.enum(["succeeded", "failed"]),
  commit: z.string().describe("The commit message that was deployed"),
  author: z.string(),
  durationSeconds: z.number(),
  url: z.string(),
});
export type Deploy = z.infer<typeof Deploy>;

export const deployFinished = events.define("deploy.finished", {
  title: "Deploy finished",
  description:
    "A deploy finished, successfully or not. Filter by service and/or environment, or leave both out to hear about every deploy.",
  input: z.object({
    service: z.string().optional().describe("Only deploys of this service, e.g. checkout-api"),
    environment: z.enum(["production", "staging"]).optional().describe("Only this environment"),
  }),
  payload: Deploy,
  // Everyone may watch every deploy in the demo. A real server checks whether this user can see
  // the service, and the check runs again before each delivery, so revoked access stops events.
  authorize: () => true,
});

/** Records a deploy and fires `deploy.finished` to every matching subscription `authorize` allows. */
export async function reportDeploy(deploy: Deploy) {
  const redis = Redis.fromEnv();
  await redis.lpush(RECENT_KEY, JSON.stringify(deploy));
  await redis.ltrim(RECENT_KEY, 0, 19);
  // The deploy id doubles as the event id, so reporting the same deploy twice delivers once.
  return deployFinished.emit(deploy, { eventId: `deploy_${deploy.id}` });
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "deploy-watch", version: "0.1.0" });
  // events/list, events/subscribe and events/unsubscribe, next to the tools.
  events.register(server);

  server.registerTool(
    "list_recent_deploys",
    {
      title: "List recent deploys",
      description: "Lists the most recent deploys, newest first.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    },
    async ({ limit }) => {
      const deploys = (await Redis.fromEnv().lrange<Deploy>(RECENT_KEY, 0, limit - 1)) ?? [];
      const lines = deploys.map(
        (d) => `${d.status === "succeeded" ? "✅" : "❌"} ${d.service} → ${d.environment}: "${d.commit}" by ${d.author} (${d.durationSeconds}s)`,
      );
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No deploys yet." }],
        structuredContent: { deploys },
      };
    },
  );

  return server;
}
