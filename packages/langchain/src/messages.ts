import type { ChatMessage } from "@upstash/agentkit-sdk";
import type { BaseMessageLike } from "./types.js";

/** AgentKit chat roles, as defined by {@link ChatMessage}. */
export type AgentKitRole = ChatMessage["role"];

/**
 * Map a LangChain message role/type onto an AgentKit {@link ChatMessage} role.
 *
 * LangChain uses several spellings depending on the API surface:
 * - message-class types from `_getType()`: `"human" | "ai" | "system" | "tool" | "function"`
 * - plain-object roles: `"user" | "assistant" | "system" | "tool"`
 *
 * Both are normalized here. Unknown roles fall back to `"user"`.
 */
export function toAgentKitRole(role: string | undefined): AgentKitRole {
  switch ((role ?? "").toLowerCase()) {
    case "human":
    case "user":
      return "user";
    case "ai":
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
    case "function":
      return "tool";
    default:
      return "user";
  }
}

/**
 * Map an AgentKit role back onto the LangChain message-class type returned by `_getType()`
 * (`"human" | "ai" | "system" | "tool"`).
 */
export function toLangChainType(role: AgentKitRole): string {
  switch (role) {
    case "user":
      return "human";
    case "assistant":
      return "ai";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "human";
  }
}

/** Resolve the role of a LangChain-style message from either `_getType()` or `role`. */
export function readMessageRole(message: BaseMessageLike): string | undefined {
  if (typeof message._getType === "function") return message._getType();
  return message.role;
}

/**
 * Convert a LangChain-style message into an AgentKit {@link ChatMessage}. Works with both message
 * class instances (via `_getType()`) and plain `{ role, content }` objects.
 */
export function fromLangChainMessage(message: BaseMessageLike): ChatMessage {
  const role = toAgentKitRole(readMessageRole(message));
  const out: ChatMessage = { role, content: message.content };
  if (message.name !== undefined) out.name = message.name;
  if (message.tool_call_id !== undefined) out.toolCallId = message.tool_call_id;
  return out;
}

/**
 * Convert an AgentKit {@link ChatMessage} into a plain LangChain-style message. The result exposes a
 * LangChain-compatible `_getType()` *and* a `role` field, so it is consumable by code that reads
 * either spelling, without depending on a real LangChain message class.
 */
export function toLangChainMessage(
  message: ChatMessage,
): Required<Pick<BaseMessageLike, "content">> & BaseMessageLike {
  const type = toLangChainType(message.role);
  const out: BaseMessageLike = {
    content: message.content,
    role: type,
    _getType: () => type,
  };
  if (message.name !== undefined) out.name = message.name;
  if (message.toolCallId !== undefined) out.tool_call_id = message.toolCallId;
  return out as Required<Pick<BaseMessageLike, "content">> & BaseMessageLike;
}
