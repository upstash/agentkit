// Drives the demo the way a model would: plain tools/call, from a client that declares nothing.
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
// Which server to drive: the QStash one (/api/mcp) or the Workflow one (/api/mcp-workflow).
const ENDPOINT = process.env.MCP_PATH ?? "/api/mcp";
const PV = "2026-07-28";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let id = 0;
async function rpc(method, params = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PV,
    "mcp-method": method,
  };
  if (params.name) headers["mcp-name"] = params.name;
  const response = await fetch(`${BASE}${ENDPOINT}`, {
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

console.log("\nALL E2E CHECKS PASSED");
