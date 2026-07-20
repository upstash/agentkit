import { defineHook } from "eve/hooks";
import { appendChatMessage } from "../lib/runtime";

/**
 * Durable transcript capture: appends every user and assistant message to Upstash Redis
 * `ChatHistory` (`agentkit:chat:<userId>:<sessionId>`) as the session streams. Redis is the
 * long-term, searchable source of truth — eve's own workflow store is pruned after a run completes.
 *
 * A thrown hook fails the turn, so persistence errors are logged and swallowed: losing one
 * transcript write should never take the conversation down.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      try {
        await appendChatMessage(ctx, "user", event.data.message);
      } catch (error) {
        console.warn("[agentkit] chat-history capture failed (user message):", error);
      }
    },
    async "message.completed"(event, ctx) {
      try {
        await appendChatMessage(ctx, "assistant", event.data.message ?? "");
      } catch (error) {
        console.warn("[agentkit] chat-history capture failed (assistant message):", error);
      }
    },
  },
});
