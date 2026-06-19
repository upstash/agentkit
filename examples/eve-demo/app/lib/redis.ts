import { resolve } from "node:path";
import { config } from "dotenv";
import { Redis } from "@upstash/redis";

config({ path: resolve(process.cwd(), "../../.env") });

let client: Redis | undefined;
export function getRedis(): Redis {
  return (client ??= Redis.fromEnv());
}
