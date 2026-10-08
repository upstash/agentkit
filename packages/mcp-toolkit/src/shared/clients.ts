/**
 * Upstash clients from env, resolved lazily: layers are built at module scope, and frameworks
 * evaluate those modules at build time without the environment.
 */
import { Redis } from "@upstash/redis";
import { Client as QStashClient, Receiver } from "@upstash/qstash";
import { addQStashTelemetry, addTelemetry } from "../telemetry.js";

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

export function env(name: string): string | undefined {
  return typeof process === "object" ? process.env?.[name] : undefined;
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
