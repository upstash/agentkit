import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { EventLog } from "./event-log.js";
import type { EventLogConfig } from "./event-log.js";
import { resolveResumeRunId } from "@tanstack/ai";
import type { StreamChunk, StreamDurability } from "@tanstack/ai";
import { addTelemetry } from "../telemetry.js";
import { assertId } from "../persistence/records.js";

const OFFSET_PREFIX = "upstash:v1:";

/**
 * The core {@link EventLogConfig} (TTL, poll interval), with `redis` optional, plus the join deadline.
 * Defaults here: `prefix` `agentkit:stream`, `ttlSeconds` 86400 (how long a run stays resumable),
 * `pollIntervalMs` 150.
 */
export type UpstashStreamConfig = Omit<EventLogConfig, "redis"> & {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /**
   * How long a from-start join (`-1` / `now`) waits for a run that has not produced anything yet
   * before failing. Raise it when the producer is queued (e.g. started by a background job).
   * @default 2000
   */
  firstChunkDeadlineMs?: number;
};

/** Explicit construction when there is no `Request` (server functions, background workers). */
export interface UpstashStreamInit {
  /** The run this adapter produces or attaches to. */
  runId: string;
  /** Resume offset captured by the consumer. Defaults to `null` (a producer / from-start reader). */
  offset?: string | null;
}

function assertRunId(runId: string): string {
  assertId(runId, "runId");
  return runId;
}

function encodeOffset(runId: string, entryId: string): string {
  return `${OFFSET_PREFIX}${encodeURIComponent(runId)}:${entryId}`;
}

function decodeOffset(offset: string): { runId: string; entryId: string } {
  if (!offset.startsWith(OFFSET_PREFIX))
    throw new Error(`Invalid upstash stream offset: ${offset}`);
  const rest = offset.slice(OFFSET_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  const entryId = rest.slice(sep + 1);
  if (sep === -1 || !/^\d+-\d+$/.test(entryId)) {
    throw new Error(`Invalid upstash stream offset: ${offset}`);
  }
  return { runId: decodeURIComponent(rest.slice(0, sep)), entryId };
}

function readResumeOffset(request: Request): string | null {
  const header = request.headers.get("Last-Event-ID");
  if (header) return header;
  try {
    return new URL(request.url).searchParams.get("offset");
  } catch {
    return null;
  }
}

/**
 * Resumable delivery for TanStack AI on Upstash Redis Streams — the multi-instance counterpart of
 * `memoryStream()`. Every chunk the producer emits is appended to a per-run stream before it is
 * delivered, so a client that reloads, drops its connection, or opens the same thread on another
 * device replays from its last offset and keeps tailing the live run, even when that request lands
 * on a different server instance than the producer.
 *
 * Offsets are opaque to callers (`upstash:v1:<runId>:<entry id>`). Construct from the incoming
 * `Request` (reads `Last-Event-ID` / `?offset` and `X-Run-Id` / `?runId`, same precedence as core),
 * or from `{ runId, offset }`.
 *
 * ```ts
 * import { chat, toServerSentEventsResponse } from "@tanstack/ai";
 * import { upstashStream } from "@upstash/agentkit-tanstack-ai";
 *
 * export async function POST(request: Request) {
 *   const stream = chat({ adapter, messages, threadId });
 *   return toServerSentEventsResponse(stream, { durability: { adapter: upstashStream(request) } });
 * }
 * ```
 */
export function upstashStream(
  source: Request | UpstashStreamInit,
  config: UpstashStreamConfig = {},
): StreamDurability {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const { firstChunkDeadlineMs = 2_000, ...logConfig } = config;
  const log = new EventLog<StreamChunk>({
    ...logConfig,
    redis,
    prefix: config.prefix ?? "agentkit:stream",
    pollIntervalMs: config.pollIntervalMs ?? 150,
  });

  const resumeOffset =
    source instanceof Request ? readResumeOffset(source) : (source.offset ?? null);
  // Object form is bound to its explicit `runId` (as `memoryStream` is): a mismatched offset is
  // rejected by `read`, never silently re-targeted. Only a Request derives the run from its offset.
  let runId: string;
  if (!(source instanceof Request)) {
    runId = assertRunId(source.runId);
  } else if (resumeOffset !== null && resumeOffset !== "-1" && resumeOffset !== "now") {
    runId = assertRunId(decodeOffset(resumeOffset).runId);
  } else {
    const requested = resolveResumeRunId(source);
    runId = requested === null ? randomUUID() : assertRunId(requested);
  }

  return {
    resumeFrom: () => resumeOffset,

    append: async (chunks) => {
      const ids = await log.append(runId, chunks);
      return ids.map((id) => encodeOffset(runId, id));
    },

    snapshot: async () =>
      (await log.snapshot(runId)).map((entry) => ({
        offset: encodeOffset(runId, entry.id),
        chunk: entry.event,
      })),

    close: () => log.close(runId),

    read: async function* (offset, signal) {
      const isFromStartJoin = offset === "-1" || offset === "now";
      let after = "0";
      if (offset === "now") {
        after = (await log.tail(runId)) ?? "0";
      } else if (!isFromStartJoin) {
        const decoded = decodeOffset(offset);
        if (decoded.runId !== runId) {
          throw new Error(
            `Upstash stream offset belongs to run ${JSON.stringify(decoded.runId)}, not ${JSON.stringify(runId)}`,
          );
        }
        // A concrete offset for a run with nothing stored means it expired (or never existed): fail
        // loudly rather than park a reader on a log that will never be written again.
        if ((await log.tail(runId)) === null && !(await log.isClosed(runId))) {
          throw new Error(`Unknown or expired upstash stream run: ${JSON.stringify(runId)}`);
        }
        after = decoded.entryId;
      }
      const hasData = (await log.tail(runId)) !== null;
      for await (const entry of log.read(runId, {
        after,
        ...(signal ? { signal } : {}),
        ...(isFromStartJoin && !hasData ? { firstEntryTimeoutMs: firstChunkDeadlineMs } : {}),
      })) {
        yield { offset: encodeOffset(runId, entry.id), chunk: entry.event };
      }
    },
  };
}
