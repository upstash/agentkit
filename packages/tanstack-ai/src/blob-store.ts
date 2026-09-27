/* global Blob */
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
import { decodeFields, encode, encodeFields } from "./codec.js";

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
  const pathPrefix = config.pathPrefix ?? "agentkit/tanstack/";
  const recordKey = (key: string) => `${prefix}:blob:${key}`;
  const indexKey = `${prefix}:blobKeys`;
  // One path segment per key, whatever characters the key holds.
  const pathFor = (key: string) => `${pathPrefix}${encodeURIComponent(key)}`;

  const assertKey = (key: string) => {
    if (typeof key !== "string" || key === "") {
      throw new Error("@upstash/agentkit-tanstack-ai: blob `key` must be a non-empty string.");
    }
  };

  const head = async (key: string): Promise<BlobRecord | null> => {
    assertKey(key);
    return decodeFields<BlobRecord>(await redis.hgetall(recordKey(key)));
  };

  async function readBytes(key: string, record: BlobRecord, range?: BlobRange) {
    const size = record.size ?? 0;
    const served = range ? resolveRange(size, range) : { offset: 0, length: size };
    if (served.length === 0) return { bytes: new Uint8Array(0), served };
    const path = pathFor(key);
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
      const stored = await bucket.put(pathFor(key), bytes, contentType ? { contentType } : {});
      const now = Date.now();
      const fields = encodeFields({
        key,
        size: bytes.byteLength,
        etag: stored.etag,
        contentType,
        customMetadata: options?.customMetadata ? { ...options.customMetadata } : undefined,
        updatedAt: now,
      });
      const tx = redis.multi();
      // createdAt is kept across overwrites; the optional fields are cleared when omitted.
      tx.hsetnx(recordKey(key), "createdAt", encode(now));
      tx.hset(recordKey(key), fields);
      if (!contentType) tx.hdel(recordKey(key), "contentType");
      if (!options?.customMetadata) tx.hdel(recordKey(key), "customMetadata");
      tx.zadd(indexKey, { score: 0, member: key });
      tx.hgetall(recordKey(key));
      const results = (await tx.exec()) as unknown[];
      return decodeFields<BlobRecord>(results[results.length - 1] as Record<string, unknown>)!;
    },

    async get(key: string, options?: BlobGetOptions): Promise<BlobObject | null> {
      const record = await head(key);
      if (!record) return null;
      let read;
      try {
        read = await readBytes(key, record, options?.range);
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
      const tx = redis.multi();
      tx.del(recordKey(key));
      tx.zrem(indexKey, key);
      await tx.exec();
      try {
        await bucket.del(pathFor(key));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
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
      const pipe = redis.pipeline();
      for (const key of pageKeys) pipe.hgetall(recordKey(key));
      const rows = pageKeys.length
        ? ((await pipe.exec()) as (Record<string, unknown> | null)[])
        : [];
      const objects = rows
        .map((row) => decodeFields<BlobRecord>(row))
        .filter((r): r is BlobRecord => r !== null);
      return {
        objects,
        ...(truncated ? { cursor: pageKeys[pageKeys.length - 1], truncated } : {}),
      };
    },
  };
}
