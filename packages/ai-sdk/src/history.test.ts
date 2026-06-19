import { ChatHistory } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createHistoryStore } from "./history.js";

describe("createHistoryStore", () => {
  let history: ChatHistory;

  beforeEach(() => {
    history = new ChatHistory({ redis: new MemoryRedis() });
  });

  it("loads an empty session as no messages", async () => {
    const store = createHistoryStore({ history });
    expect(await store.load("s1")).toEqual([]);
  });

  it("saves core messages and loads them back", async () => {
    const store = createHistoryStore({ history });
    await store.save("s1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    const loaded = await store.load("s1");
    expect(loaded).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  it("appends the model result as an assistant message", async () => {
    const store = createHistoryStore({ history });
    await store.save("s1", [{ role: "user", content: "Q" }]);
    await store.saveResult("s1", { text: "A" });
    const loaded = await store.load("s1");
    expect(loaded).toEqual([
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ]);
  });

  it("respects the limit option when loading", async () => {
    const store = createHistoryStore({ history });
    await store.save("s1", [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    const loaded = await store.load("s1", { limit: 2 });
    expect(loaded.map((m) => m.content)).toEqual(["2", "3"]);
  });
});
