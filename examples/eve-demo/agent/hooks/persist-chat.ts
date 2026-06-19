import { defineChatHistoryHook } from "@upstash/agentkit-eve";

import { redis } from "../redis.js";

// Persist every conversation to Redis as the durable source of truth (eve's
// Workflow session store is pruned 1–30 days after a run completes). The hook
// itself lives in the SDK — see `defineChatHistoryHook`; here we just configure it.
// Chats are stored under a fixed demo user, keyed by the eve session id.
export default defineChatHistoryHook({ redis, userId: "eve-demo-user" });
