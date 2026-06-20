import { resolve } from "node:path";
import { config } from "dotenv";
import { Redis } from "@upstash/redis";

// Load a local `.env` (copy from `.env.example`) first, then fall back to the repo-root `.env`.
// dotenv doesn't overwrite already-set vars, so the local file wins.
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

let client: Redis | undefined;
export function getRedis(): Redis {
  return (client ??= Redis.fromEnv());
}
