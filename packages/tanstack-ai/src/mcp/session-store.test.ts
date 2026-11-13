import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolDefinition } from "@tanstack/ai";
import { createMcpAppCallHandler } from "@tanstack/ai-mcp/apps";
import type { McpServerDescriptor } from "@tanstack/ai-mcp/apps";
import { createMCPServer } from "@tanstack/ai-mcp/server";
import { z } from "zod";
import { upstashMcpSessionStore } from "./session-store.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "Bearer s3cr3t-token";
const isDelete = (tool: { name: string }) => tool.name === "delete_doc";

/** A real MCP server over HTTP that only answers requests carrying the stored `Authorization`. */
async function startMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const read = toolDefinition({
    name: "read_doc",
    description: "Read a doc",
    inputSchema: z.object({ id: z.string() }),
  }).server(async ({ id }) => `doc ${id}`);
  const remove = toolDefinition({
    name: "delete_doc",
    description: "Delete a doc",
    inputSchema: z.object({ id: z.string() }),
  }).server(async ({ id }) => `deleted ${id}`);
  const mcp = createMCPServer({
    name: "docs",
    version: "1.0.0",
    tools: [read, remove],
    sessions: "stateless",
  });

  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== TOKEN) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const response = await mcp.fetch(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!hasRedisCreds)("upstashMcpSessionStore (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tmcps");
  let n = 0;
  const next = () => `${prefix}:${++n}`;
  let mcp: Awaited<ReturnType<typeof startMcpServer>>;

  beforeAll(async () => {
    mcp = await startMcpServer();
  });
  afterAll(async () => {
    await mcp.close();
    await cleanupKeys(redis, prefix);
  });

  const docs = (): McpServerDescriptor => ({
    transport: { type: "http", url: mcp.url, headers: { authorization: TOKEN } },
    prefix: "docs",
    toolFilter: ["read_doc", "delete_doc"],
    needsApproval: isDelete,
    requestOptions: { timeout: 10_000 },
  });

  it("round-trips the JSON part and returns null for unknown threads and servers", async () => {
    const store = upstashMcpSessionStore({ redis, prefix: next() });
    expect(await store.get("t1", "docs")).toBeNull();
    await store.set("t1", {
      docs: { transport: { type: "stdio", command: "node", args: ["server.js"] }, prefix: "docs" },
    });
    expect(await store.get("t1", "docs")).toEqual({
      transport: { type: "stdio", command: "node", args: ["server.js"] },
      prefix: "docs",
    });
    expect(await store.get("t1", "other")).toBeNull();
    expect(await store.get("t2", "docs")).toBeNull();
  });

  it("resolves an omitted serverId only when the thread has exactly one server", async () => {
    const store = upstashMcpSessionStore({ redis, prefix: next() });
    const stdio = (command: string): McpServerDescriptor => ({
      transport: { type: "stdio", command },
    });
    await store.set("t", { a: stdio("a") });
    expect(await store.get("t", undefined)).toMatchObject({ transport: { command: "a" } });
    await store.set("t", { a: stdio("a"), b: stdio("b") });
    expect(await store.get("t", undefined)).toBeNull();
    await store.set("t", { b: stdio("b") });
    expect(await store.get("t", "a")).toBeNull(); // set replaces the thread's whole map
  });

  it("fails closed when a code-only field is not supplied again, and restores it via resolve", async () => {
    const p = next();
    await upstashMcpSessionStore({ redis, prefix: p }).set("t", { docs: docs() });
    expect(await upstashMcpSessionStore({ redis, prefix: p }).get("t", "docs")).toBeNull();

    const seen: string[][] = [];
    const store = upstashMcpSessionStore({
      redis,
      prefix: p,
      resolve: ({ missing }) => {
        seen.push([...missing]);
        return { needsApproval: isDelete };
      },
    });
    const descriptor = await store.get("t", "docs");
    expect(seen).toEqual([["needsApproval"]]);
    expect(descriptor?.needsApproval).toBe(isDelete);
    // JSON-safe fields, the array toolFilter included, came back from Redis as they were.
    expect(descriptor).toMatchObject({
      prefix: "docs",
      toolFilter: ["read_doc", "delete_doc"],
      requestOptions: { timeout: 10_000 },
      transport: { type: "http", url: mcp.url, headers: { authorization: TOKEN } },
    });
  });

  it("encrypts each entry at rest, bound to the thread and server", async () => {
    const p = next();
    const store = upstashMcpSessionStore({
      redis,
      prefix: p,
      encryptionKey: KEY,
      resolve: () => ({ needsApproval: isDelete }),
    });
    await store.set("t", { docs: docs() });
    const raw = JSON.stringify(await redis.hgetall(`${p}:mcp:session:t`));
    expect(raw).not.toContain("s3cr3t-token");
    expect(raw).not.toContain(mcp.url);
    expect((await store.get("t", "docs"))?.transport).toMatchObject({
      headers: { authorization: TOKEN },
    });

    // Copying the row to another thread does not decrypt: the ciphertext is bound to where it was saved.
    await redis.hset(`${p}:mcp:session:u`, {
      docs: (await redis.hget(`${p}:mcp:session:t`, "docs"))!,
    });
    await expect(store.get("u", "docs")).rejects.toThrow();
    // And a store without the key refuses instead of handing out a partial descriptor.
    await expect(upstashMcpSessionStore({ redis, prefix: p }).get("t", "docs")).rejects.toThrow(
      /encryptionKey/,
    );
  });

  it("slides the TTL on get", async () => {
    const p = next();
    const store = upstashMcpSessionStore({ redis, prefix: p, ttlSeconds: 100 });
    await store.set("t", { a: { transport: { type: "stdio", command: "a" } } });
    await redis.expire(`${p}:mcp:session:t`, 5);
    await store.get("t", "a");
    expect(await redis.ttl(`${p}:mcp:session:t`)).toBeGreaterThan(50);
  });

  describe("with createMcpAppCallHandler against a real MCP server", () => {
    it("calls allowed tools and keeps the approval gate a widget must not bypass", async () => {
      const store = upstashMcpSessionStore({
        redis,
        prefix: next(),
        encryptionKey: KEY,
        resolve: () => ({ needsApproval: isDelete }),
      });
      await store.set("thread-1", { docs: docs() });
      // No static clients: the thread's servers exist only in the store.
      const handle = createMcpAppCallHandler({ clients: [], store });

      const read = await handle({
        threadId: "thread-1",
        serverId: "docs",
        toolName: "read_doc",
        args: { id: "7" },
      });
      expect(read.ok).toBe(true);
      expect(JSON.stringify(read)).toContain("doc 7");

      const remove = await handle({
        threadId: "thread-1",
        serverId: "docs",
        toolName: "delete_doc",
        args: { id: "7" },
      });
      expect(remove).toEqual({ ok: false, error: "Tool needs approval: delete_doc" });
    });
  });
});
