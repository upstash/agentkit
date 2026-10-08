// Drives the demo the way a model and a host would: plain JSON-RPC from a client that declares
// nothing, and no model anywhere. Run it against a running app (`pnpm smoke`), or let `pnpm e2e`
// start QStash and the app and run it against both task servers.
//
//   MCP_PATH=/api/mcp            the QStash task server, plus Deploy Watch (events)  [default]
//   MCP_PATH=/api/mcp-workflow   the Workflow task server
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Redis } from "@upstash/redis";

if (existsSync(".env.local")) process.loadEnvFile(".env.local"); // never overrides what is set

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const ENDPOINT = process.env.MCP_PATH ?? "/api/mcp";
const EXECUTE = ENDPOINT === "/api/mcp-workflow" ? "/api/execute-workflow" : "/api/execute";
const WATCH = "/api/deploy-watch";
const PV = "2026-07-28";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// Demo users: the MCP routes accept `Bearer demo-<name>` (see app/lib/auth.ts).
const ALICE = "demo-alice";
const BOB = "demo-bob";
const INTERN = "demo-intern"; // Deploy Watch's authorize keeps production deploys from this one

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

let id = 0;
function post(path, method, params, user) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PV,
    "mcp-method": method,
  };
  if (params.name) headers["mcp-name"] = params.name;
  if (user) headers.authorization = `Bearer ${user}`;
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PV,
          "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function rpc(method, params = {}, { path = ENDPOINT, user = ALICE } = {}) {
  const response = await post(path, method, params, user);
  check(response.ok, `${method}: HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) {
    throw Object.assign(new Error(`${method}: ${JSON.stringify(json.error)}`), { rpc: json.error });
  }
  return json.result;
}

const call = (name, args, user = ALICE) => rpc("tools/call", { name, arguments: args }, { user });
const statusOf = (result) => result.structuredContent?.status;
const textOf = (result) => (result.content ?? []).map((part) => part.text ?? "").join("\n");
const isUnknown = (result) => result.isError === true && /Unknown task/.test(textOf(result));
const brief = (result) =>
  JSON.stringify({ status: statusOf(result), statusMessage: result.structuredContent?.statusMessage });

/** Polls task_status as `user` until the task is final, or `tries` polls have passed. */
async function poll(taskId, user = ALICE, tries = 30) {
  let last;
  for (let i = 0; i < tries; i++) {
    await sleep(1500);
    last = await call("task_status", { taskId }, user);
    console.log("  poll", brief(last));
    if (TERMINAL.has(statusOf(last))) break;
  }
  return last;
}

/** Waits until `ready()` resolves true, checking once a second. */
async function until(ready, what, tries = 25) {
  for (let i = 0; i < tries; i++) {
    if (await ready()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let passed = 0;
async function test(name, body) {
  console.log(`\n== ${name} ==`);
  await body();
  passed++;
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

let hasFailTool = false;

await test(`tools/list (${ENDPOINT})`, async () => {
  const names = (await rpc("tools/list")).tools.map((tool) => tool.name);
  console.log(" ", names.join(", "));
  for (const expected of ["generate_report", "task_status", "task_cancel"]) {
    check(names.includes(expected), `missing tool ${expected}`);
  }
  hasFailTool = names.includes("always_fail");
});

await test("a token the server doesn't accept is refused", async () => {
  const response = await post(ENDPOINT, "tools/list", {}, "not-a-demo-user");
  console.log("  HTTP", response.status);
  check(response.status === 401, `expected 401, got ${response.status}`);
});

await test("happy path, and another user can neither see nor cancel the task", async () => {
  const created = await call("generate_report", { topic: "coffee trends" });
  const taskId = created.structuredContent?.taskId;
  check(taskId && statusOf(created) === "working", `expected a working task, got ${brief(created)}`);
  console.log("  alice started", taskId);

  const peek = await call("task_status", { taskId }, BOB);
  check(isUnknown(peek), `bob must see alice's task as unknown, got ${JSON.stringify(peek)}`);
  check(peek.structuredContent === undefined, "an unknown task must leak no structuredContent");
  const steal = await call("task_cancel", { taskId }, BOB);
  check(isUnknown(steal), `bob must not cancel alice's task, got ${JSON.stringify(steal)}`);
  console.log("  bob: unknown task, for both task_status and task_cancel");

  const last = await poll(taskId);
  check(statusOf(last) === "completed", `expected completed, got ${statusOf(last)}`);
  check(last.content.length >= 2, "the completed status must carry the handler's own content");
});

await test("cancel mid-flight", async () => {
  const created = await call("generate_report", { topic: "tea rituals" });
  const taskId = created.structuredContent.taskId;
  await sleep(3000);
  console.log("  cancel", brief(await call("task_cancel", { taskId })));
  await sleep(6000);
  const after = await call("task_status", { taskId });
  console.log("  after ", brief(after));
  check(statusOf(after) === "cancelled", `expected cancelled, got ${statusOf(after)}`);
  check(!after.structuredContent?.result, "a cancelled task must not carry a result");
});

await test("an unknown task id", async () => {
  const unknown = await call("task_status", { taskId: randomUUID() });
  check(isUnknown(unknown), `expected an unknown-task error, got ${JSON.stringify(unknown)}`);
  const malformed = await call("task_status", { taskId: "does-not-exist" });
  check(malformed.isError === true, "a malformed id must be a tool error");
});

await test("a task that always throws ends failed", async () => {
  if (!hasFailTool) {
    console.log("  skipped: start the app with MCP_TOOLKIT_E2E=1 (pnpm e2e does)");
    return;
  }
  const created = await call("always_fail", {});
  const last = await poll(created.structuredContent.taskId);
  check(statusOf(last) === "failed", `expected failed, got ${statusOf(last)}`);
  check(last.structuredContent?.error?.message, "a failed task must carry an error");
  console.log("  error", last.structuredContent.error.message);
});

await test("unsigned and forged deliveries are refused", async () => {
  const routes = [
    [EXECUTE, { taskId: randomUUID() }],
    [`${WATCH}/events`, { subscriptionId: "sub_forged", envelope: {} }],
  ];
  for (const [path, body] of routes) {
    for (const signature of [undefined, "eyJhbGciOiJIUzI1NiJ9.e30.forged"]) {
      const response = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "upstash-signature": signature } : {}),
        },
        body: JSON.stringify(body),
      });
      await response.body?.cancel();
      console.log(`  ${path} ${signature ? "forged" : "unsigned"}: HTTP ${response.status}`);
      check(!response.ok, `${path} accepted a delivery that QStash didn't sign`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Events (Deploy Watch). Only on the default run: the events server doesn't change with MCP_PATH.
// ---------------------------------------------------------------------------------------------

if (ENDPOINT === "/api/mcp") {
  const redis = Redis.fromEnv();
  const subscriptionKey = (subscriptionId) => `deploy-watch:events:sub:${subscriptionId}`;

  /** A fresh webhook receiver on the demo's /api/receiver, with its own signing secret. */
  async function receiver() {
    const url = `${BASE}/api/receiver?id=${randomBytes(6).toString("hex")}`;
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    await fetch(url, { method: "PUT", body: JSON.stringify({ secret }) });
    return {
      url,
      secret,
      received: async () =>
        (await (await fetch(url)).json()).filter((r) => r.body.name === "deploy.finished"),
      forget: () => fetch(url, { method: "DELETE" }),
    };
  }

  const subscribe = (user, args, to) =>
    rpc(
      "events/subscribe",
      {
        name: "deploy.finished",
        arguments: args,
        delivery: { mode: "webhook", url: to.url, secret: to.secret },
        ttlMs: 600_000,
      },
      { path: WATCH, user },
    );
  const unsubscribe = (user, args, to) =>
    rpc(
      "events/unsubscribe",
      { name: "deploy.finished", arguments: args, delivery: { mode: "webhook", url: to.url } },
      { path: WATCH, user },
    );
  const report = async (deploy) =>
    (await (await fetch(`${BASE}${WATCH}/deploys`, { method: "POST", body: JSON.stringify(deploy) })).json())
      .deploy;

  await test("Deploy Watch: filtering, per-user subscriptions, authorize at delivery", async () => {
    const listed = (await rpc("events/list", {}, { path: WATCH })).events.map((e) => e.name);
    check(listed.includes("deploy.finished"), "missing deploy.finished event");

    const ops = await receiver();
    const alices = await subscribe(ALICE, { environment: "production" }, ops);
    console.log("  alice subscribed to production:", alices.id);

    // The same unsubscribe from another user: the id includes the subscriber, so nothing changes.
    await unsubscribe(BOB, { environment: "production" }, ops);
    check(await redis.exists(subscriptionKey(alices.id)), "bob removed alice's subscription");
    console.log("  bob's unsubscribe left it alone");

    // authorize: the intern can't ask for production, but may subscribe to everything…
    const intern = await receiver();
    const refused = await subscribe(INTERN, { environment: "production" }, intern).then(
      () => undefined,
      (error) => error.rpc,
    );
    check(refused?.data?.reason === "not_authorized", `expected not_authorized, got ${JSON.stringify(refused)}`);
    await subscribe(INTERN, {}, intern);
    console.log("  intern: refused for production, subscribed to everything");

    const staging = await report({ environment: "staging", commit: "staging only" });
    const production = await report({ environment: "production", status: "failed" });
    console.log("  reported", staging.id, "(staging)", production.id, "(production)");

    await until(
      async () => (await ops.received()).length > 0 && (await intern.received()).length > 0,
      "both deliveries",
    );
    await sleep(3000); // anything that shouldn't arrive has had time to

    const toOps = await ops.received();
    const toIntern = await intern.received();
    const summary = (list) => list.map((r) => `${r.body.data.environment}${r.valid ? "" : " (bad signature)"}`);
    console.log("  alice got", summary(toOps), "· intern got", summary(toIntern));
    check(toOps.length === 1 && toOps[0].body.data.id === production.id, "alice must get only the production deploy");
    check(toOps[0].valid, "alice's delivery signature did not verify");
    // …and each delivery is authorized against the deploy itself, so production never reaches them.
    check(toIntern.length === 1 && toIntern[0].body.data.id === staging.id, "the intern must get only staging");
    check(toIntern[0].valid, "the intern's delivery signature did not verify");

    const recent = await rpc("tools/call", { name: "list_recent_deploys", arguments: { limit: 2 } }, { path: WATCH });
    check(textOf(recent).includes("staging only"), "list_recent_deploys missed the staging deploy");

    await unsubscribe(ALICE, { environment: "production" }, ops);
    await unsubscribe(INTERN, {}, intern);
    check(!(await redis.exists(subscriptionKey(alices.id))), "unsubscribe left the subscription behind");
  });

  await test("Deploy Watch: a 410 from the host deletes the subscription", async () => {
    const gone = await receiver();
    const { id: subscriptionId } = await subscribe(ALICE, { environment: "staging" }, gone);
    check(await redis.exists(subscriptionKey(subscriptionId)), "subscription not stored");
    await gone.forget(); // its next POST answers 410
    await report({ environment: "staging", commit: "to a receiver that is gone" });
    await until(async () => !(await redis.exists(subscriptionKey(subscriptionId))), "the subscription to be deleted");
    console.log("  deleted", subscriptionId);
  });
}

console.log(`\nALL ${passed} E2E CHECKS PASSED (${ENDPOINT})`);
