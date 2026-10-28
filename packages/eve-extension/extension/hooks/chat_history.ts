import { defineHook } from "eve/hooks";
import { appendChatMessage } from "../lib/runtime";

/**
 * Durable transcript capture: appends every user and assistant message to Upstash Redis
 * `ChatHistory` (`agentkit:chat:<userId>:<sessionId>`) as the session streams. Redis is the
 * long-term, searchable source of truth — eve's own workflow store is pruned after a run completes.
 *
 * User text arrives on `delivery.consumed` (the v27 successor of `message.received`); the
 * assistant's answer is each text part of `content.completed` with `phase: "reply"` (narration
 * between tool calls is not stored).
 *
 * A thrown hook fails the turn, so persistence errors are logged and swallowed: losing one
 * transcript write should never take the conversation down.
 */
export default defineHook({
  events: {
    async "delivery.consumed"(event, ctx) {
      const text = event.data.parts
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join("\n");
      try {
        await appendChatMessage(ctx, "user", text);
      } catch (error) {
        console.warn("[agentkit] chat-history capture failed (user message):", error);
      }
    },
    async "content.completed"(event, ctx) {
      const { kind, phase, value } = event.data;
      if (kind !== "text" || phase !== "reply" || typeof value !== "string") return;
      try {
        await appendChatMessage(ctx, "assistant", value);
      } catch (error) {
        console.warn("[agentkit] chat-history capture failed (assistant message):", error);
      }
    },
  },
});
