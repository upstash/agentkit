/**
 * Test-only stand-in for an `@upstash/blob` `Bucket`: objects in memory, and `signedReadUrl` served by
 * a local HTTP server that honours `Range` (answering 206), so the store's range-read path is
 * exercised over real HTTP rather than short-circuited.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { BlobBucketLike } from "../persistence/blob-store.js";

export interface TestBucket extends BlobBucketLike {
  close(): Promise<void>;
  /** Paths currently stored, for asserting on what the store wrote. */
  paths(): string[];
  /** How many Range requests the HTTP server answered with 206. */
  rangeHits: number;
}

export async function testBucket(): Promise<TestBucket> {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const tokens = new Map<string, string>();
  let rangeHits = 0;
  const server: Server = createServer((req, res) => {
    const path = tokens.get((req.url ?? "").slice(1));
    const object = path ? objects.get(path) : undefined;
    if (!object) {
      res.writeHead(404).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), object.bytes.byteLength - 1);
      rangeHits++;
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${object.bytes.byteLength}` });
      res.end(Buffer.from(object.bytes.subarray(start, end + 1)));
      return;
    }
    res.writeHead(200).end(Buffer.from(object.bytes));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const toBytes = async (body: unknown): Promise<Uint8Array> => {
    if (body instanceof Uint8Array) return new Uint8Array(body);
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return new Uint8Array(
      await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
    );
  };

  const bucket: TestBucket = {
    rangeHits: 0,
    async put(path, body) {
      const bytes = await toBytes(body);
      const etag = randomUUID();
      objects.set(path, { bytes, etag });
      return { etag, size: bytes.byteLength };
    },
    async get(path) {
      const object = objects.get(path);
      if (!object) throw Object.assign(new Error("not found"), { code: "not_found" });
      const bytes = object.bytes.slice();
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
    async del(path) {
      objects.delete(path);
    },
    async signedReadUrl(path) {
      const token = randomUUID();
      tokens.set(token, path);
      return { url: `http://127.0.0.1:${port}/${token}` };
    },
    paths: () => [...objects.keys()],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  Object.defineProperty(bucket, "rangeHits", { get: () => rangeHits });
  return bucket;
}
