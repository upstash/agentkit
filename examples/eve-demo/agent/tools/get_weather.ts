import { defineCachedTool } from "@upstash/agentkit-eve";
import { z } from "zod";

import { redis } from "../redis.js";

/** Stand-in for a real weather API call. */
async function fetchWeather(city: string) {
  return { city, condition: "Sunny", temperatureF: 72 };
}

// A normal eve tool, but its `execute` result is memoized in an Upstash ToolCache
// so repeated calls for the same input skip `fetchWeather` (and any real upstream
// API). The cache key is `agentkit:toolCache:<namespace>:<hash-of-input>`.
// `defineCachedTool` calls eve's `defineTool` internally, so export it directly.
export default defineCachedTool({
  description: "Get the current weather for a city.", // shown to the model
  inputSchema: z.object({ city: z.string().min(1) }), // zod schema, infers `execute` input
  namespace: "get_weather", // cache key — a string, or (input, ctx) => string
  redis, // optional: Upstash client; defaults to Redis.fromEnv()
  ttlSeconds: 600, // optional: per-result TTL (omit to cache indefinitely)
  async execute({ city }) {
    return fetchWeather(city);
  },
});
