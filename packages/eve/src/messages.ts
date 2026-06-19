import type { ChatMessage } from "@upstash/agentkit-sdk";
import type { EveMessage } from "./types.js";

/**
 * AgentKit's {@link ChatMessage} roles. Eve messages may carry arbitrary roles; anything outside this
 * set is normalized to `user` so the result is always a valid {@link ChatMessage}.
 */
const AGENTKIT_ROLES = new Set<ChatMessage["role"]>(["system", "user", "assistant", "tool"]);

/** Convert AgentKit {@link ChatMessage}s into Eve-style messages. */
export function toEveMessages(messages: ChatMessage[]): EveMessage[] {
  return messages.map((m) => {
    const out: EveMessage = { role: m.role, content: m.content };
    if (m.name !== undefined) out.name = m.name;
    return out;
  });
}

/**
 * Convert Eve-style messages back into AgentKit {@link ChatMessage}s. Unknown roles fall back to
 * `user`; non-string content is coerced to a string.
 */
export function fromEveMessages(messages: EveMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const role = AGENTKIT_ROLES.has(m.role as ChatMessage["role"])
      ? (m.role as ChatMessage["role"])
      : "user";
    const out: ChatMessage = {
      role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    };
    if (m.name !== undefined) out.name = m.name;
    return out;
  });
}
