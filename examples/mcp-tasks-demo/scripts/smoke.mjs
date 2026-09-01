// Drives the demo the way the browser does: raw stateless JSON-RPC.
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PV = "2026-07-28";
const EXT = "io.modelcontextprotocol/tasks";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let id = 0;
async function rpc(method, params = {}, { caps = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PV,
    "mcp-method": method,
  };
  if (params.name) headers["mcp-name"] = params.name;
  if (params.taskId) headers["mcp-name"] = params.taskId;
  const response = await fetch(`${BASE}/api/mcp`, {
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
          "io.modelcontextprotocol/clientCapabilities": caps ? { extensions: { [EXT]: {} } } : {},
        },
      },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const brief = t =>
  JSON.stringify({
    status: t.status,
    statusMessage: t.statusMessage,
    ...(t.result ? { result: t.result } : {}),
  });

console.log("== tools/list ==");
const list = await rpc("tools/list");
console.log(list.tools.map(t => t.name).join(", "));

console.log("\n== 1. happy path ==");
const created = await rpc("tools/call", {
  name: "generate_report",
  arguments: { topic: "coffee trends" },
});
console.log("created", JSON.stringify(created));
if (created.resultType !== "task") throw new Error("expected a task handle");

let last;
for (let i = 0; i < 20; i++) {
  await sleep(1500);
  last = await rpc("tasks/get", { taskId: created.taskId });
  console.log("poll  ", brief(last));
  if (["completed", "failed", "cancelled"].includes(last.status)) break;
}
if (last.status !== "completed") throw new Error(`expected completed, got ${last.status}`);

console.log("\n== 2. cancel mid-flight ==");
const second = await rpc("tools/call", {
  name: "generate_report",
  arguments: { topic: "tea rituals" },
});
console.log("created", second.taskId);
await sleep(3000);
const cancelled = await rpc("tasks/cancel", { taskId: second.taskId });
console.log("cancel", brief(cancelled));
await sleep(6000);
const afterCancel = await rpc("tasks/get", { taskId: second.taskId });
console.log("after ", brief(afterCancel));
if (afterCancel.status !== "cancelled") throw new Error(`expected cancelled, got ${afterCancel.status}`);
if (afterCancel.result) throw new Error("a cancelled task must not carry a result");

console.log("\n== 3. client without the tasks capability ==");
const refused = await rpc(
  "tools/call",
  { name: "generate_report", arguments: { topic: "nope" } },
  { caps: false },
);
console.log("refused", JSON.stringify(refused));
if (!refused.isError) throw new Error("expected a tool error");

console.log("\n== 4. unknown task ==");
try {
  await rpc("tasks/get", { taskId: "does-not-exist" });
  throw new Error("expected an error");
} catch (e) {
  console.log("errored as expected:", e.message.slice(0, 120));
}

console.log("\nALL E2E CHECKS PASSED");
