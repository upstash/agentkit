import type { ChatMessage } from "@upstash/agentkit-sdk";
import type { CoreMessageLike, TextPartLike } from "./types.js";

/**
 * AgentKit's {@link ChatMessage} allows the `tool` role, which the AI SDK represents differently
 * (tool results live in dedicated tool-message parts). For conversion fidelity we map the AgentKit
 * `tool` role onto the AI SDK `tool` role and back; everything else is a 1:1 role match.
 */
const AGENTKIT_ROLES = new Set<ChatMessage["role"]>(["system", "user", "assistant", "tool"]);

/** Flatten an AI-SDK content value (string or array of parts) into a plain string. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as TextPartLike;
        return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .join("");
  }
  return "";
}

/**
 * Convert AgentKit {@link ChatMessage}s into AI-SDK-style core messages with plain string `content`.
 * Suitable for passing as the `messages` argument to the AI SDK's `generateText`/`streamText`.
 */
export function toCoreMessages(messages: ChatMessage[]): CoreMessageLike[] {
  return messages.map((m) => {
    const core: CoreMessageLike = { role: m.role, content: m.content };
    if (m.name !== undefined) core.name = m.name;
    return core;
  });
}

/**
 * Convert AI-SDK-style core messages back into AgentKit {@link ChatMessage}s. Structured (array)
 * content is flattened to a string; unknown roles fall back to `user` so the result is always a valid
 * {@link ChatMessage}.
 */
export function fromCoreMessages(messages: CoreMessageLike[]): ChatMessage[] {
  return messages.map((m) => {
    const role = AGENTKIT_ROLES.has(m.role as ChatMessage["role"])
      ? (m.role as ChatMessage["role"])
      : "user";
    const out: ChatMessage = { role, content: flattenContent(m.content) };
    if (m.name !== undefined) out.name = m.name;
    return out;
  });
}
