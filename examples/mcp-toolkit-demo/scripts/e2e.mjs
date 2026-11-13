// The whole e2e run in one command, with no model and no QStash account: starts the local QStash
// dev server and the built app, runs smoke.mjs against the QStash and the Workflow task servers
// (the first run also covers Deploy Watch), then stops everything.
//
// Needs UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (environment or .env.local) and a built
// app (`pnpm build`). CI runs it after building the examples.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

let stopping = false;
process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));
if (existsSync(".env.local")) process.loadEnvFile(".env.local"); // never overrides what is set

for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
  if (!process.env[name]) fail(`${name} is not set (environment or .env.local).`);
}
if (!existsSync(".next/BUILD_ID")) fail("No build found. Run `pnpm build` first.");

// Off the dev defaults (3000, 8080), so a `pnpm dev` and `pnpm qstash` can keep running.
const APP_PORT = process.env.E2E_APP_PORT ?? "3100";
const QSTASH_PORT = process.env.E2E_QSTASH_PORT ?? "8181";
const BASE = `http://127.0.0.1:${APP_PORT}`;

const children = [];
process.on("exit", () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole group: npx starts the real server as a child
    } catch {}
  }
});
process.on("SIGINT", () => process.exit(130));

/** Starts a long-running process in its own group, keeping the tail of its output for errors. */
function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  const keep = (chunk) => (child.output = (child.output + chunk).slice(-8000));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("exit", (code) => {
    if (!stopping) fail(`${name} exited early (code ${code}):\n${child.output}`);
  });
  children.push(child);
  return child;
}

function fail(message) {
  stopping = true;
  console.error(`\ne2e: ${message}`);
  process.exit(1);
}

async function waitFor(what, ready, seconds = 90) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await ready().catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`timed out waiting for ${what}`);
}

// 1. The QStash dev server. Its token and signing keys are read from what it prints.
const qstash = start("QStash dev server", "npx", ["-y", "@upstash/qstash-cli", "dev", "-port", QSTASH_PORT]);
const credentials = await waitFor("the QStash dev server", async () => {
  const read = (name) => new RegExp(`${name}=(\\S+)`).exec(qstash.output)?.[1];
  const [token, current, next] = ["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"].map(read);
  return token && current && next ? { token, current, next } : undefined;
});
console.log(`e2e: QStash dev server on :${QSTASH_PORT}`);

// 2. The built app, pointed at it, with the e2e hooks on (app/lib/e2e.ts).
const app = start("the app", "npx", ["next", "start", "-H", "127.0.0.1", "-p", APP_PORT], {
  QSTASH_URL: `http://127.0.0.1:${QSTASH_PORT}`,
  QSTASH_TOKEN: credentials.token,
  QSTASH_CURRENT_SIGNING_KEY: credentials.current,
  QSTASH_NEXT_SIGNING_KEY: credentials.next,
  APP_URL: BASE,
  MCP_EVENTS_SECRET_KEY: randomBytes(32).toString("base64"),
  MCP_TOOLKIT_E2E: "1",
});
await waitFor("the app", async () => (await fetch(BASE)).status < 500);
console.log(`e2e: app on ${BASE}`);

// 3. smoke.mjs against each task server.
for (const path of ["/api/mcp", "/api/mcp-workflow"]) {
  const code = await new Promise((resolve) => {
    spawn("node", ["scripts/smoke.mjs"], {
      env: { ...process.env, BASE, MCP_PATH: path },
      stdio: "inherit",
    }).on("exit", resolve);
  });
  if (code !== 0) fail(`smoke.mjs failed against ${path}. Last app output:\n${app.output}`);
}

stopping = true;
console.log("\ne2e: all runs passed");
process.exit(0);
