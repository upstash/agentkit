/* global Blob */
import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import type {
  BlobBody,
  BlobGetOptions,
  BlobListOptions,
  BlobListPage,
  BlobObject,
  BlobPutOptions,
  BlobRange,
  BlobRecord,
  BlobStore,
} from "@tanstack/ai-persistence";
import { addTelemetry } from "../telemetry.js";
import { KEY_LOCKING, loadDocs } from "./records.js";

/**
 * Commit a put: point the key at its newly uploaded object version, write the record (keeping the
 * original `createdAt` across overwrites) and index the key, all at once. Returns the stored record
 * and the version it replaced, whose bytes the caller then deletes.
 * KEYS: record document, key index, current-version pointer. ARGV: record JSON, key, version path.
 */
const PUT_RECORD = `${KEY_LOCKING}local previous = redis.call("GET", KEYS[3]) or ""
redis.call("SET", KEYS[3], ARGV[3])
local created = redis.call("JSON.GET", KEYS[1], "$.createdAt")
redis.call("JSON.SET", KEYS[1], "$", ARGV[1])
if created and created ~= "[]" then
  redis.call("JSON.SET", KEYS[1], "$.createdAt", string.sub(created, 2, -2))
end
redis.call("ZADD", KEYS[2], 0, ARGV[2])
return {redis.call("JSON.GET", KEYS[1]), previous}`;

/** Remove a key's record, pointer and index entry at once; returns the version path to delete. */
const DELETE_RECORD = `${KEY_LOCKING}local previous = redis.call("GET", KEYS[3]) or ""
redis.call("DEL", KEYS[1], KEYS[3])
redis.call("ZREM", KEYS[2], ARGV[1])
return previous`;

/**
 * The slice of an `@upstash/blob` `Bucket` this store uses — pass `Bucket.fromEnv()`. Structural,
 * so `@upstash/blob` stays an optional peer and tests can supply a stand-in.
 */
export interface BlobBucketLike {
  put(
    path: string,
    body: Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>,
    options?: { contentType?: string },
  ): Promise<{ etag: string; size: number }>;
  get(path: string): Promise<{ body: ReadableStream<Uint8Array> }>;
  del(target: string): Promise<void>;
  /** Used for byte-range reads (a `Range` request against a short-lived signed URL). */
  signedReadUrl?(path: string): Promise<{ url: string }>;
}

export interface UpstashBlobStoreConfig {
  /** The Upstash Blob bucket holding the bytes, e.g. `Bucket.fromEnv()` from `@upstash/blob`. */
  bucket: BlobBucketLike;
  /** Upstash Redis client holding each blob's record and the key index. */
  redis: Redis;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
  /** Redis key prefix for the records. */
  prefix: string;
  /**
   * Path prefix for objects in the bucket.
   * @default "agentkit/tanstack/"
   */
  pathPrefix?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function toBytes(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob)
    return new Uint8Array(await body.arrayBuffer());
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return readAll(body);
  throw new TypeError("Unsupported blob body.");
}

/** Same rules as TanStack's `resolveBlobRange`: clamp the length, reject an offset outside the object. */
function resolveRange(size: number, range: BlobRange): { offset: number; length: number } {
  const { offset } = range;
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) {
    throw new RangeError(`Blob range offset ${offset} is outside the object (size ${size}).`);
  }
  const remaining = size - offset;
  if (range.length === undefined) return { offset, length: remaining };
  if (!Number.isInteger(range.length) || range.length < 0) {
    throw new RangeError(`Blob range length ${range.length} is not valid.`);
  }
  return { offset, length: Math.min(range.length, remaining) };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; message?: unknown } | null;
  return (
    e?.code === "not_found" || e?.status === 404 || /not.?found|404/i.test(String(e?.message ?? ""))
  );
}

/**
 * A TanStack AI `BlobStore` split across the two stores each part fits: the **bytes** go to Upstash
 * Blob (S3-compatible object storage), and each blob's **record** (size, etag, content type, custom
 * metadata, created/updated times) goes to Redis next to a lexically ordered key index.
 *
 * That split is what makes the contract exact: `head` and `list` are Redis reads (Blob listings omit
 * content type and metadata), `list` pages in key order with a key cursor, and `createdAt` survives an
 * overwrite. Byte ranges are read with a `Range` request on a short-lived signed URL, so a video can be
 * served in slices without downloading it whole.
 *
 * Writes put the bytes first and the record second, deletes remove the record first — a crash in
 * between leaves at most an orphaned object, never a record pointing at nothing.
 */
export function upstashBlobStore(config: UpstashBlobStoreConfig): BlobStore {
  const { bucket, redis, prefix } = config;
  addTelemetry(redis, config.enableTelemetry);
  const pathPrefix = config.pathPrefix ?? "agentkit/tanstack/";
  const recordKey = (key: string) => `${prefix}:blob:${key}`;
  const versionKey = (key: string) => `${prefix}:blobVersion:${key}`;
  const indexKey = `${prefix}:blobKeys`;
  // One path segment per key, whatever characters the key holds.
  // Every put uploads to a fresh, immutable version path, so concurrent writers never share an
  // object: whichever commits last wins the pointer, and a record never describes another
  // writer's bytes. The replaced version is deleted only after the commit.
  const newVersionPath = (key: string) => `${pathPrefix}${encodeURIComponent(key)}/${randomUUID()}`;
  const dropVersion = async (path: unknown) => {
    if (typeof path !== "string" || path === "") return;
    try {
      await bucket.del(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };

  const assertKey = (key: string) => {
    if (typeof key !== "string" || key === "") {
      throw new Error("@upstash/agentkit-tanstack-ai: blob `key` must be a non-empty string.");
    }
  };

  const head = async (key: string): Promise<BlobRecord | null> => {
    assertKey(key);
    return (await redis.json.get<BlobRecord>(recordKey(key))) ?? null;
  };

  async function readBytes(path: string, record: BlobRecord, range?: BlobRange) {
    const size = record.size ?? 0;
    const served = range ? resolveRange(size, range) : { offset: 0, length: size };
    if (served.length === 0) return { bytes: new Uint8Array(0), served };
    if (range && bucket.signedReadUrl) {
      const { url } = await bucket.signedReadUrl(path);
      const end = served.offset + served.length - 1;
      const res = await fetch(url, { headers: { Range: `bytes=${served.offset}-${end}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Upstash Blob range read failed with ${res.status}.`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range answers 200 with the whole object; slice it ourselves.
      return {
        bytes:
          res.status === 206 ? bytes : bytes.subarray(served.offset, served.offset + served.length),
        served,
      };
    }
    const all = await readAll((await bucket.get(path)).body);
    return { bytes: all.subarray(served.offset, served.offset + served.length), served };
  }

  return {
    async put(key: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobRecord> {
      assertKey(key);
      const bytes = await toBytes(body);
      const contentType =
        options?.contentType ??
        (typeof Blob !== "undefined" && body instanceof Blob ? body.type || undefined : undefined);
      const path = newVersionPath(key);
      const stored = await bucket.put(path, bytes, contentType ? { contentType } : {});
      const now = Date.now();
      // A full replace: omitted optional fields are cleared, and only createdAt survives an overwrite.
      const record: BlobRecord = {
        key,
        size: bytes.byteLength,
        etag: stored.etag,
        ...(contentType ? { contentType } : {}),
        ...(options?.customMetadata ? { customMetadata: { ...options.customMetadata } } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const [stored_, previous] = (await redis.eval(
        PUT_RECORD,
        [recordKey(key), indexKey, versionKey(key)],
        [JSON.stringify(record), key, path],
      )) as [BlobRecord, string];
      if (previous !== path) await dropVersion(previous);
      return stored_;
    },

    async get(key: string, options?: BlobGetOptions): Promise<BlobObject | null> {
      assertKey(key);
      // The record and its version pointer are read together, so the bytes fetched are the ones
      // the record describes even while another writer commits.
      const tx = redis.multi();
      tx.json.get(recordKey(key));
      tx.get(versionKey(key));
      const [record, path] = (await tx.exec()) as [BlobRecord | null, string | null];
      if (!record || !path) return null;
      let read;
      try {
        read = await readBytes(path, record, options?.range);
      } catch (error) {
        if (error instanceof RangeError) throw error;
        if (isNotFound(error)) return null;
        throw error;
      }
      if (!read) return null;
      const { bytes, served } = read;
      return {
        ...record,
        ...(options?.range ? { range: served } : {}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice());
            controller.close();
          },
        }),
        arrayBuffer: () => Promise.resolve(toArrayBuffer(bytes)),
        text: () => Promise.resolve(decoder.decode(bytes)),
      };
    },

    head,

    async delete(key: string): Promise<void> {
      assertKey(key);
      const previous = await redis.eval(
        DELETE_RECORD,
        [recordKey(key), indexKey, versionKey(key)],
        [key],
      );
      await dropVersion(previous);
    },

    async list(options?: BlobListOptions): Promise<BlobListPage> {
      const limit = options?.limit;
      if (limit === 0) return { objects: [], truncated: false };
      const prefixFilter = options?.prefix ?? "";
      const keys: string[] = [];
      // Walk the lexical index from max(prefix, cursor), keeping keys under the prefix, until we have
      // one more than the page (to know whether it is truncated) or leave the prefix range.
      let min: `(${string}` | `[${string}` =
        options?.cursor !== undefined && options.cursor >= prefixFilter
          ? `(${options.cursor}`
          : `[${prefixFilter}`;
      const PAGE = 200;
      for (;;) {
        const batch = (await redis.zrange(indexKey, min, "+", {
          byLex: true,
          offset: 0,
          count: PAGE,
        })) as string[];
        let left = false;
        for (const key of batch) {
          if (!key.startsWith(prefixFilter)) {
            if (key > prefixFilter) left = true;
            if (left) break;
            continue;
          }
          keys.push(key);
          if (limit !== undefined && keys.length > limit) break;
        }
        if (left || batch.length < PAGE || (limit !== undefined && keys.length > limit)) break;
        min = `(${batch[batch.length - 1]}`;
      }
      const truncated = limit !== undefined && keys.length > limit;
      const pageKeys = truncated ? keys.slice(0, limit) : keys;
      const objects = await loadDocs<BlobRecord>(redis, pageKeys.map(recordKey));
      return {
        objects,
        ...(truncated ? { cursor: pageKeys[pageKeys.length - 1], truncated } : {}),
      };
    },
  };
}
