// Drives the demo the way a model would: plain tools/call, from a client that declares nothing.
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
// Which server to drive: the QStash one (/api/mcp) or the Workflow one (/api/mcp-workflow).
const ENDPOINT = process.env.MCP_PATH ?? "/api/mcp";
const PV = "2026-07-28";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let id = 0;
async function rpc(method, params = {}, path = ENDPOINT) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PV,
    "mcp-method": method,
  };
  if (params.name) headers["mcp-name"] = params.name;
  const response = await fetch(`${BASE}${path}`, {
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
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const call = (name, args) => rpc("tools/call", { name, arguments: args });

const brief = r =>
  JSON.stringify({
    status: r.structuredContent?.status,
    statusMessage: r.structuredContent?.statusMessage,
    ...(r.structuredContent?.result ? { result: r.structuredContent.result } : {}),
  });

console.log(`== tools/list (${ENDPOINT}) ==`);
const names = (await rpc("tools/list")).tools.map(t => t.name);
console.log(names.join(", "));
for (const expected of ["generate_report", "task_status", "task_cancel"]) {
  if (!names.includes(expected)) throw new Error(`missing tool ${expected}`);
}

console.log("\n== 1. happy path ==");
const created = await call("generate_report", { topic: "coffee trends" });
console.log("created", JSON.stringify(created));
const taskId = created.structuredContent?.taskId;
if (!taskId) throw new Error("expected a task handle");

let last;
for (let i = 0; i < 20; i++) {
  await sleep(1500);
  last = await call("task_status", { taskId });
  console.log("poll  ", brief(last));
  if (["completed", "failed", "cancelled"].includes(last.structuredContent?.status)) break;
}
if (last.structuredContent?.status !== "completed") {
  throw new Error(`expected completed, got ${last.structuredContent?.status}`);
}

console.log("\n== 2. cancel mid-flight ==");
const second = await call("generate_report", { topic: "tea rituals" });
const secondId = second.structuredContent.taskId;
console.log("created", secondId);
await sleep(3000);
console.log("cancel", brief(await call("task_cancel", { taskId: secondId })));
await sleep(6000);
const afterCancel = await call("task_status", { taskId: secondId });
console.log("after ", brief(afterCancel));
if (afterCancel.structuredContent?.status !== "cancelled") {
  throw new Error(`expected cancelled, got ${afterCancel.structuredContent?.status}`);
}
if (afterCancel.structuredContent?.result) throw new Error("a cancelled task must not carry a result");

console.log("\n== 3. unknown task ==");
const unknown = await call("task_status", { taskId: "does-not-exist" });
console.log("unknown", JSON.stringify(unknown));
if (!unknown.isError) throw new Error("expected a tool error");

if (ENDPOINT === "/api/mcp") {
  // Deploy Watch: the events server. No tasks involved.
  const WATCH = "/api/deploy-watch";
  console.log("\n== 4. Deploy Watch: deploy.finished ==");
  const { randomBytes } = await import("node:crypto");
  const listed = (await rpc("events/list", {}, WATCH)).events.map(e => e.name);
  console.log("events", listed.join(", "));
  if (!listed.includes("deploy.finished")) throw new Error("missing deploy.finished event");

  const receiverId = randomBytes(6).toString("hex");
  const receiverUrl = `${BASE}/api/receiver?id=${receiverId}`;
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  await fetch(receiverUrl, { method: "PUT", body: JSON.stringify({ secret }) });
  // Only production deploys: the staging one below must not arrive.
  const subscription = await rpc(
    "events/subscribe",
    {
      name: "deploy.finished",
      arguments: { environment: "production" },
      delivery: { mode: "webhook", url: receiverUrl, secret },
      ttlMs: 600_000,
    },
    WATCH,
  );
  console.log("subscribed", subscription.id);

  const report = async body =>
    (await fetch(`${BASE}${WATCH}/deploys`, { method: "POST", body: JSON.stringify(body) })).json();
  const staging = await report({ environment: "staging", commit: "staging only" });
  const production = await report({ environment: "production", status: "failed" });
  console.log("reported", staging.deploy.id, "(staging)", production.deploy.id, "(production)");

  let received = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    received = (await (await fetch(receiverUrl)).json()).filter(r => r.body.name === "deploy.finished");
    if (received.length) break;
  }
  await sleep(2000);
  received = (await (await fetch(receiverUrl)).json()).filter(r => r.body.name === "deploy.finished");
  console.log("delivered", JSON.stringify(received.map(r => ({ valid: r.valid, id: r.body.data.id, env: r.body.data.environment }))));
  if (received.length !== 1) throw new Error(`expected exactly one delivery, got ${received.length}`);
  if (!received[0].valid) throw new Error("delivery signature did not verify");
  if (received[0].body.data.id !== production.deploy.id) throw new Error("wrong deploy delivered");

  const recent = await rpc("tools/call", { name: "list_recent_deploys", arguments: { limit: 2 } }, WATCH);
  console.log("recent", recent.content[0].text.split("\n").join(" | "));

  await rpc(
    "events/unsubscribe",
    { name: "deploy.finished", arguments: { environment: "production" }, delivery: { mode: "webhook", url: receiverUrl } },
    WATCH,
  );
}

console.log("\nALL E2E CHECKS PASSED");
