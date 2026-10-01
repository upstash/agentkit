import { addTelemetry as tagClient } from "@upstash/agentkit-sdk";
import { VERSION } from "./version.js";

/** The telemetry tag of this package, appended to the redis client's `Upstash-Telemetry-Sdk` header. */
export const TANSTACK_AI_TELEMETRY = `@upstash/agentkit-tanstack-ai@${VERSION}`;

/**
 * Tag the redis client with this adapter's sdk name + version. The core primitives built underneath
 * add their own `@upstash/agentkit-sdk` tag, so the header reports both layers. Opt out with
 * `enableTelemetry: false`, the same option on the redis client, or `UPSTASH_DISABLE_TELEMETRY`.
 */
export function addTelemetry(redis: unknown, enableTelemetry?: boolean): void {
  tagClient(redis, { sdk: TANSTACK_AI_TELEMETRY, enabled: enableTelemetry });
}
