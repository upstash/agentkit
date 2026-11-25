import { VERSION } from "./version.js";

/**
 * Minimal shape of the redis client we need for telemetry. `addTelemetry` is `protected` in
 * `@upstash/redis`, so it is not part of the public types.
 */
type TelemetryCapableRedis = {
  addTelemetry?: (telemetry: { sdk?: string; platform?: string; runtime?: string }) => void;
};

/** The telemetry tag of this package, appended to the redis client's `Upstash-Telemetry-Sdk` header. */
export const RESUMABLE_STREAM_TELEMETRY = `@upstash/agentkit-resumable-stream@${VERSION}`;

/**
 * The redis client *appends* to the telemetry header on every `addTelemetry` call, so each client
 * is tagged once no matter how many publishers, subscribers and stores are built on it.
 */
const taggedClients = new WeakSet<object>();

const getSafeEnv = (): Record<string, string | undefined> =>
  typeof process === "object" && process && typeof process.env === "object" ? process.env : {};

/**
 * Reports this package's name and version to Upstash through the redis client's telemetry header,
 * producing a header like `@upstash/redis@1.41.0,@upstash/agentkit-resumable-stream@0.1.0`.
 *
 * Opt out with `enableTelemetry: false` on any config of this package, with the same option on the
 * redis client itself, or with the `UPSTASH_DISABLE_TELEMETRY` env var.
 */
export function addTelemetry(redis: unknown, enableTelemetry = true): void {
  if (!enableTelemetry || getSafeEnv().UPSTASH_DISABLE_TELEMETRY) return;
  if (!redis || typeof redis !== "object" || taggedClients.has(redis)) return;
  taggedClients.add(redis);
  try {
    // addTelemetry is intentionally hidden from the public types of @upstash/redis
    (redis as TelemetryCapableRedis).addTelemetry?.({ sdk: RESUMABLE_STREAM_TELEMETRY });
  } catch {
    // telemetry must never break the client
  }
}
