import type { Redis } from "@upstash/redis";
import { describe, expect, it, vi } from "vitest";
import { createUpstashPublisher } from "./publisher.js";
import { createUpstashSubscriber } from "./subscriber.js";
import { MemoryRedisServer } from "./testing/memory-redis.js";
import { pollUntil } from "./test-support.js";

const options = { enableTelemetry: false } as const;

describe("createUpstashSubscriber", () => {
  it("resolves subscribe only once the subscription is confirmed", async () => {
    const server = new MemoryRedisServer({ latencyMs: 30 });
    const subscriber = createUpstashSubscriber(server.client(), options);
    const pending = subscriber.subscribe("ch", () => undefined);
    expect(server.subscriberCount("ch")).toBe(0);
    await pending;
    expect(server.subscriberCount("ch")).toBe(1);
    expect(subscriber.channels()).toEqual(["ch"]);
  });

  it("delivers the publisher's messages as the original text, in order", async () => {
    const server = new MemoryRedisServer();
    const subscriber = createUpstashSubscriber(server.client(), options);
    const publisher = createUpstashPublisher(server.client(), options);
    const got: string[] = [];
    await subscriber.subscribe("ch", (message) => got.push(message));
    const sent = ["42", "true", "", 'data: {"a":1}\n\n', "null"];
    for (const message of sent) await publisher.publish("ch", message);
    await publisher.flush();
    expect(await pollUntil(() => got.length === sent.length)).toBe(true);
    expect(got).toEqual(sent);
  });

  it("unsubscribe ends the subscription", async () => {
    const server = new MemoryRedisServer();
    const subscriber = createUpstashSubscriber(server.client(), options);
    const callback = vi.fn();
    await subscriber.subscribe("ch", callback);
    await subscriber.unsubscribe("ch");
    expect(server.subscriberCount("ch")).toBe(0);
    expect(subscriber.channels()).toEqual([]);
    await server.client().publish("ch", '{"d":"late"}');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects a channel name with a comma", async () => {
    const subscriber = createUpstashSubscriber(new MemoryRedisServer().client(), options);
    await expect(subscriber.subscribe("a,b", () => undefined)).rejects.toThrow(/comma/);
  });

  it("rejects when the subscription request fails, and cleans up", async () => {
    const server = new MemoryRedisServer();
    const subscriber = createUpstashSubscriber(server.client(), options);
    server.failNext = 1;
    await expect(subscriber.subscribe("ch", () => undefined)).rejects.toThrow(/simulated/);
    expect(subscriber.channels()).toEqual([]);
  });

  it("rejects when the subscription is never confirmed", async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const silent = { subscribe: () => ({ on: () => undefined, unsubscribe }) } as unknown as Redis;
    const subscriber = createUpstashSubscriber(silent, { ...options, subscribeTimeoutMs: 30 });
    await expect(subscriber.subscribe("ch", () => undefined)).rejects.toThrow(/Timed out/);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("reports a throwing or rejecting callback to onError", async () => {
    const server = new MemoryRedisServer();
    const onError = vi.fn();
    const subscriber = createUpstashSubscriber(server.client(), { ...options, onError });
    await subscriber.subscribe("sync", () => {
      throw new Error("sync boom");
    });
    await subscriber.subscribe("async", async () => {
      throw new Error("async boom");
    });
    await server.client().publish("sync", '{"d":"x"}');
    await server.client().publish("async", '{"d":"x"}');
    expect(await pollUntil(() => onError.mock.calls.length === 2)).toBe(true);
    expect(onError.mock.calls.map((call) => call[1]).sort()).toEqual(["async", "sync"]);
  });
});
