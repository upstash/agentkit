import { VERSION } from "./version.js";

const tagged = new WeakSet<object>();

/**
 * Appends `@upstash/agentkit-resumable-stream@<version>` to the client's `Upstash-Telemetry-Sdk`
 * header, once per client. Off with the client's `enableTelemetry: false` or
 * `UPSTASH_DISABLE_TELEMETRY`. `addTelemetry` is protected in `@upstash/redis`, hence the cast.
 */
export function addTelemetry(redis: object): void {
  if (
    tagged.has(redis) ||
    (typeof process === "object" && process.env?.UPSTASH_DISABLE_TELEMETRY)
  ) {
    return;
  }
  tagged.add(redis);
  try {
    (redis as { addTelemetry?: (t: { sdk: string }) => void }).addTelemetry?.({
      sdk: `@upstash/agentkit-resumable-stream@${VERSION}`,
    });
  } catch {
    // telemetry must never break the client
  }
}
