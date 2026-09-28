/**
 * Global setup: build the app if needed, then start TWO production servers (`next start`) on free
 * ports against the same Upstash Redis, with the scripted model. Tests talk to both, so every
 * scenario can start something on one instance and finish it on the other.
 *
 * Skipped (no servers, tests skip too) without UPSTASH_REDIS_REST_URL / _TOKEN.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { GlobalSetupContext } from "vitest/node";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const nextBin = `${appDir}node_modules/.bin/next`;
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

declare module "vitest" {
  export interface ProvidedContext {
    instances: { a: string; b: string } | null;
    demoPrefix: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitUntilUp(url: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up:\n${log()}`);
}

export default async function setup({ provide }: GlobalSetupContext) {
  const demoPrefix = `tanstack-ai-demo-e2e:${randomUUID()}`;
  provide("demoPrefix", demoPrefix);
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    provide("instances", null);
    return;
  }

  if (!existsSync(`${appDir}.next/BUILD_ID`)) {
    const build = spawnSync(nextBin, ["build"], { cwd: appDir, stdio: "inherit" });
    if (build.status !== 0) throw new Error("next build failed");
  }

  const env = {
    ...process.env,
    AGENTKIT_MOCK_MODEL: "1",
    MOCK_WORD_DELAY_MS: process.env.MOCK_WORD_DELAY_MS ?? "60",
    DEMO_PREFIX: demoPrefix,
    NODE_ENV: "production" as const,
  };
  const children: ChildProcess[] = [];
  const urls: string[] = [];
  for (let i = 0; i < 2; i++) {
    const port = await freePort();
    // `next` itself (not `npx`, which would leave it orphaned), in its own process group so
    // teardown can stop it and anything it spawned.
    const child = spawn(nextBin, ["start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    children.push(child);
    const url = `http://127.0.0.1:${port}`;
    await waitUntilUp(`${url}/`, child, () => output);
    urls.push(url);
  }
  provide("instances", { a: urls[0]!, b: urls[1]! });

  return async () => {
    for (const child of children) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
}
