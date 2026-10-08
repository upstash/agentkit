/**
 * Upstash clients from env, resolved lazily: layers are built at module scope, and frameworks
 * evaluate those modules at build time without the environment.
 */
import { Redis } from "@upstash/redis";
import { Client as QStashClient, Receiver } from "@upstash/qstash";
import { addQStashTelemetry, addTelemetry } from "../telemetry.js";
import { env } from "./env.js";

export { INTERNAL_ERROR, env } from "./env.js";

/** Calls `create` once, on first access. */
export function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      value = create();
      done = true;
    }
    return value as T;
  };
}

/** A Redis client, from config or env, tagged with this package's telemetry. */
export function resolveRedis(owner: string, redis: Redis | undefined, telemetry = true): Redis {
  const client = redis ?? redisFromEnv(owner);
  addTelemetry(client, { enabled: telemetry });
  return client;
}

/** A QStash client, from config or env, tagged with this package's telemetry. */
export function resolveQStash(
  owner: string,
  qstash: QStashClient | undefined,
  telemetry = true,
): QStashClient {
  const client =
    qstash ??
    new QStashClient({ token: requireEnv(owner, "QSTASH_TOKEN"), baseUrl: env("QSTASH_URL") });
  addQStashTelemetry(client, { enabled: telemetry });
  return client;
}

/** A signature verifier, from config or env. Throws without keys: there is no unverified mode. */
export function resolveReceiver(owner: string, receiver: Receiver | undefined): Receiver {
  if (receiver) return receiver;
  const currentSigningKey = env("QSTASH_CURRENT_SIGNING_KEY");
  const nextSigningKey = env("QSTASH_NEXT_SIGNING_KEY");
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error(
      `${owner} needs signing keys: pass \`receiver\`, or set QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY.`,
    );
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

function redisFromEnv(owner: string): Redis {
  return new Redis({
    url: requireEnv(owner, "UPSTASH_REDIS_REST_URL"),
    token: requireEnv(owner, "UPSTASH_REDIS_REST_TOKEN"),
  });
}

export function requireEnv(owner: string, name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${owner} needs ${name} (or pass the client explicitly).`);
  return value;
}

/**
 * QStash retries every non-2xx response. This status and header tell it to stop and dead-letter
 * the message instead, for requests a retry cannot fix.
 */
export function nonRetryable(message: string): Response {
  return new Response(message, { status: 489, headers: { "Upstash-NonRetryable-Error": "true" } });
}

/**
 * A receiver that always checks the signature was issued for `url`. Upstash Workflow verifies
 * with only the body and signature, which would accept a delivery signed for any other endpoint.
 */
export function boundToUrl(receiver: Receiver, url: string): Receiver {
  return Object.assign(Object.create(receiver) as Receiver, {
    verify: (request: Parameters<Receiver["verify"]>[0]) => receiver.verify({ ...request, url }),
  });
}

/**
 * Reads a QStash delivery: verifies its signature against `url`, the URL we published to (behind
 * a proxy `request.url` is the internal one), then parses the JSON body. Anything wrong comes back
 * as a non-retryable response.
 */
export async function readQStashJson(
  request: Request,
  receiver: Receiver,
  url: string,
): Promise<unknown> {
  const body = await request.text();
  try {
    const signature = request.headers.get("upstash-signature") ?? "";
    if (!(await receiver.verify({ signature, body, url })))
      return nonRetryable("invalid signature");
  } catch {
    return nonRetryable("invalid signature");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return nonRetryable("malformed body");
  }
}
