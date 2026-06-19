import { ChatHistory } from "@upstash/agentkit-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHistoryStore } from "./history.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("createHistoryStore", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("history");
  let history: ChatHistory;

  beforeAll(() => {
    history = new ChatHistory({ redis, namespace });
  });

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("loads an empty session as no messages", async () => {
    const store = createHistoryStore({ history });
    expect(await store.load("empty")).toEqual([]);
  });

  it("saves core messages and loads them back", async () => {
    const store = createHistoryStore({ history });
    await store.save("roundtrip", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    const loaded = await store.load("roundtrip");
    expect(loaded).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  it("appends the model result as an assistant message", async () => {
    const store = createHistoryStore({ history });
    await store.save("result", [{ role: "user", content: "Q" }]);
    await store.saveResult("result", { text: "A" });
    const loaded = await store.load("result");
    expect(loaded).toEqual([
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ]);
  });

  it("respects the limit option when loading", async () => {
    const store = createHistoryStore({ history });
    await store.save("limited", [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    const loaded = await store.load("limited", { limit: 2 });
    expect(loaded.map((m) => m.content)).toEqual(["2", "3"]);
  });
});
