import type { ChatHistory } from "@upstash/agentkit-sdk";
import { fromTanStackMessage, toTanStackMessage, toTanStackMessages } from "./messages.js";
import type { TanStackMessage } from "./types.js";

/**
 * Generates an assistant reply given the full conversation (prior history plus the new user
 * message), in TanStack-AI-style. Injected by the caller so it can be mocked in tests and backed by
 * any model in production. Return either a string (used as `content`) or a full message object.
 */
export type ChatGenerate = (
  messages: TanStackMessage[],
) => Promise<string | TanStackMessage> | string | TanStackMessage;

export interface ChatHandlerConfig {
  /** The AgentKit {@link ChatHistory} used to load and persist the conversation. */
  history: ChatHistory;
  /** Produces the assistant reply. Mock this in tests. */
  generate: ChatGenerate;
  /** Load at most this many recent messages as context. */
  limit?: number;
}

export interface ChatTurnInput {
  sessionId: string;
  /** The incoming user message (string shorthand or a full message). */
  message: string | TanStackMessage;
}

export interface ChatTurnResult {
  /** The persisted assistant message. */
  message: TanStackMessage;
  /** The conversation after this turn (history + user + assistant), oldest-first. */
  messages: TanStackMessage[];
}

function normalizeUserMessage(message: string | TanStackMessage): TanStackMessage {
  return typeof message === "string" ? { role: "user", content: message } : message;
}

function normalizeAssistantMessage(result: string | TanStackMessage): TanStackMessage {
  return typeof result === "string"
    ? { role: "assistant", content: result }
    : { ...result, role: "assistant" };
}

/**
 * Build a server-side chat handler that, for each turn, loads prior history, runs the injected
 * `generate`, and persists *both* the user and assistant messages before returning the assistant
 * reply. This keeps the stored conversation consistent without the caller managing persistence.
 *
 * @example
 * ```ts
 * const handler = createChatHandler({ history, generate: myModel });
 * const { message } = await handler({ sessionId: "s1", message: "Hello" });
 * ```
 */
export function createChatHandler(
  config: ChatHandlerConfig,
): (input: ChatTurnInput) => Promise<ChatTurnResult> {
  const { history, generate, limit } = config;
  return async ({ sessionId, message }: ChatTurnInput): Promise<ChatTurnResult> => {
    const prior = await history.list(sessionId, limit !== undefined ? { limit } : {});
    const userMessage = normalizeUserMessage(message);

    const conversation: TanStackMessage[] = [...toTanStackMessages(prior), userMessage];
    const generated = await generate(conversation);
    const assistantMessage = normalizeAssistantMessage(generated);

    // Persist user then assistant so the stored order matches the live conversation.
    await history.append(sessionId, [
      fromTanStackMessage(userMessage),
      fromTanStackMessage(assistantMessage),
    ]);

    return {
      message: toTanStackMessage(fromTanStackMessage(assistantMessage)),
      messages: [...conversation, assistantMessage],
    };
  };
}
