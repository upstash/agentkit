import { addTelemetry as tagClient } from "@upstash/agentkit-sdk";
import { VERSION } from "./version.js";

/** The telemetry tag of this package, appended to the redis client's `Upstash-Telemetry-Sdk` header. */
export const EVE_TELEMETRY = `@upstash/agentkit-eve@${VERSION}`;

/**
 * Tag the redis client with this adapter's sdk name + version. The core primitives built underneath
 * add their own `@upstash/agentkit-sdk` tag, so the header reports both layers. Each client is
 * tagged once per sdk name; opt out with `enableTelemetry: false`, with the same option on the redis
 * client, or with the `UPSTASH_DISABLE_TELEMETRY` env var.
 */
export function addTelemetry(redis: unknown, enableTelemetry?: boolean): void {
  tagClient(redis, { sdk: EVE_TELEMETRY, enabled: enableTelemetry });
}
