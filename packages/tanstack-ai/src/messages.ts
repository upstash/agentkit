import type { ChatMessage } from "@upstash/agentkit-sdk";
import type { TanStackMessage, TanStackRole } from "./types.js";

/** Roles AgentKit and TanStack AI share 1:1. */
const ROLES: readonly TanStackRole[] = ["system", "user", "assistant", "tool"];

function asRole(role: string): TanStackRole {
  return (ROLES as readonly string[]).includes(role) ? (role as TanStackRole) : "user";
}

/**
 * Convert a single AgentKit {@link ChatMessage} into a TanStack-AI-style message. Any extra metadata
 * is spread onto the result so it survives a round-trip back through {@link fromTanStackMessage}.
 */
export function toTanStackMessage(message: ChatMessage): TanStackMessage {
  const { role, content, name, toolCallId, createdAt, metadata } = message;
  const out: TanStackMessage = {
    role: asRole(role),
    content,
  };
  if (name !== undefined) out.name = name;
  if (toolCallId !== undefined) out.toolCallId = toolCallId;
  if (createdAt !== undefined) out.createdAt = createdAt;
  // Surface a stable id when one was stashed in metadata during a prior conversion.
  if (metadata && typeof metadata["id"] === "string") out.id = metadata["id"];
  if (metadata) {
    const { id: _id, ...rest } = metadata;
    if (Object.keys(rest).length > 0) out.metadata = rest;
  }
  return out;
}

/** Convert an array of AgentKit messages to TanStack-AI-style messages. */
export function toTanStackMessages(messages: ChatMessage[]): TanStackMessage[] {
  return messages.map(toTanStackMessage);
}

/**
 * Convert a single TanStack-AI-style message into an AgentKit {@link ChatMessage}. A TanStack `id`
 * (which AgentKit's `ChatMessage` has no first-class field for) is preserved inside `metadata.id`, so
 * round-tripping is lossless.
 */
export function fromTanStackMessage(message: TanStackMessage): ChatMessage {
  const { id, role, content, name, toolCallId, createdAt, metadata } = message;
  const out: ChatMessage = {
    role: asRole(role),
    content,
  };
  if (name !== undefined) out.name = name;
  if (toolCallId !== undefined) out.toolCallId = toolCallId;
  if (createdAt !== undefined) out.createdAt = createdAt;

  const mergedMetadata: Record<string, unknown> = {
    ...(metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}),
  };
  if (id !== undefined) mergedMetadata["id"] = id;
  if (Object.keys(mergedMetadata).length > 0) out.metadata = mergedMetadata;
  return out;
}

/** Convert an array of TanStack-AI-style messages to AgentKit messages. */
export function fromTanStackMessages(messages: TanStackMessage[]): ChatMessage[] {
  return messages.map(fromTanStackMessage);
}
