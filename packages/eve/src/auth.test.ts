import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "eve/channels/auth";
import { Ratelimit, createRateLimitAuth } from "./index.js";
import { hasRedisCreds, testRedis } from "./test-support.js";

// Only POST requests (the model-invoking message submissions) are counted, so default to POST here.
const req = () => new Request("http://localhost/agent", { method: "POST" });

describe.skipIf(!hasRedisCreds)("createRateLimitAuth (live Redis)", () => {
  const redis = testRedis();

  // `identifier` is required (no implicit "global" bucket). Here we verify the gate behavior it
  // powers — under the limit it falls through (returns null), over it rejects with a 403.
  it("falls through under the limit, throws ForbiddenError over it", async () => {
    const auth = createRateLimitAuth({
      redis,
      limiter: Ratelimit.slidingWindow(1, "60 s"),
      identifier: `test:${randomUUID().slice(0, 8)}`, // a fresh bucket per run
    });

    // First request is within the window → returns null so the auth walk continues.
    expect(await auth(req())).toBeNull();

    // Second request is over the limit → the gate rejects.
    await expect(auth(req())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("limits each identifier independently", async () => {
    const idA = `test:${randomUUID().slice(0, 8)}`;
    const idB = `test:${randomUUID().slice(0, 8)}`;
    const auth = createRateLimitAuth({
      redis,
      limiter: Ratelimit.slidingWindow(1, "60 s"),
      identifier: (request) => (request.headers.get("x-user") === "b" ? idB : idA),
    });

    const reqFor = (user: string) =>
      new Request("http://localhost/agent", { method: "POST", headers: { "x-user": user } });

    // Exhaust A's bucket; B's is untouched and still passes.
    expect(await auth(reqFor("a"))).toBeNull();
    await expect(auth(reqFor("a"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await auth(reqFor("b"))).toBeNull();
  });

  // eve runs the auth walk on the follow-up `GET …/stream` too; only POSTs (which invoke the model)
  // are counted, so a turn isn't charged twice. A GET always falls through without touching the limiter.
  it("does not count non-POST requests (e.g. the stream GET)", async () => {
    const auth = createRateLimitAuth({
      redis,
      limiter: Ratelimit.slidingWindow(1, "60 s"),
      identifier: `test:${randomUUID().slice(0, 8)}`,
    });
    const get = () => new Request("http://localhost/agent", { method: "GET" });

    // Many GETs in a row never exhaust the (size-1) window — they're not counted at all.
    expect(await auth(get())).toBeNull();
    expect(await auth(get())).toBeNull();
    expect(await auth(get())).toBeNull();
  });
});
