import { VERSION } from "./version.js";

/**
 * Minimal shape of the redis client we need for telemetry. `addTelemetry` is `protected` in
 * `@upstash/redis`, so it is not part of the public types.
 */
type TelemetryCapableRedis = {
  addTelemetry?: (telemetry: { sdk?: string; platform?: string; runtime?: string }) => void;
};

/** The telemetry tag of this (core) package. Adapters pass their own package tag instead. */
export const SDK_TELEMETRY = `@upstash/agentkit-sdk@${VERSION}`;

/**
 * The redis client *appends* to the telemetry header on every `addTelemetry` call, so each client is
 * tagged once per sdk name no matter how many primitives are built on it. The set is per client
 * because one process can hold several clients; the sdk name is part of the key because a core
 * primitive and the adapter that wrapped it both tag the same client with different names.
 */
const taggedClients = new WeakMap<object, Set<string>>();

const getSafeEnv = (): Record<string, string | undefined> =>
  typeof process === "object" && process && typeof process.env === "object" ? process.env : {};

/**
 * Reports the sdk name and version to Upstash through the redis client's telemetry headers. The
 * redis client already reports the platform and the runtime, so we only append our own sdk tag,
 * resulting in a header like
 * `@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-ai-sdk@0.2.0`.
 *
 * Opt out with `enableTelemetry: false` on any AgentKit config, with the same option on the redis
 * client itself, or with the `UPSTASH_DISABLE_TELEMETRY` env var.
 */
export const addTelemetry = (
  redis: unknown,
  options: {
    /** The sdk tag to report. Defaults to {@link SDK_TELEMETRY} (this package). */
    sdk?: string;
    /** Set `false` to skip reporting. Defaults to `true`. */
    enabled?: boolean;
  } = {},
): void => {
  const { sdk = SDK_TELEMETRY, enabled = true } = options;
  if (!enabled || getSafeEnv().UPSTASH_DISABLE_TELEMETRY) return;
  if (!redis || typeof redis !== "object") return;

  let tags = taggedClients.get(redis);
  if (!tags) taggedClients.set(redis, (tags = new Set<string>()));
  if (tags.has(sdk)) return;
  tags.add(sdk);

  try {
    // addTelemetry is intentionally hidden from the public types of @upstash/redis
    (redis as TelemetryCapableRedis).addTelemetry?.({ sdk });
  } catch {
    // telemetry must never break the client
  }
};
