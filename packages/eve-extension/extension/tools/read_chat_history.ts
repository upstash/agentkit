import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { chatHistory, requireChatHistory, resolveUserId } from "../lib/runtime";

/** Cap the transcript a single read can pull into context. */
const MAX_MESSAGES = 50;

/**
 * The read half of chat history: search finds the session, this reads it back. Dynamic for the same
 * reason as the search tool — chat history is off by default and only binds at runtime.
 *
 * `userId` comes from the session, so `sessionId` alone can't address another user's chat: the key is
 * `<prefix>:<userId>:<sessionId>` and core `ChatHistory` rejects a `:` in either id.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      if (!chatHistory()) return null;
      return defineTool({
        description:
          "Read one of this user's past conversations in full, by the `sessionId` returned from the " +
          "chat-history search tool. Returns the transcript, newest messages last.",
        inputSchema: z.object({
          sessionId: z
            .string()
            .min(1)
            .describe("The chat's `sessionId`, as returned by the chat-history search tool."),
          limit: z
            .number()
            .int()
            .positive()
            .max(MAX_MESSAGES)
            .optional()
            .describe(
              `Max messages to return, counting back from the end of the conversation. ` +
                `Defaults to ${MAX_MESSAGES}.`,
            ),
        }),
        async execute({ sessionId, limit }, ctx) {
          const chat = await requireChatHistory().getChat({
            userId: resolveUserId(ctx),
            sessionId,
          });
          if (!chat) {
            return { found: false as const, sessionId };
          }
          const take = Math.min(limit ?? MAX_MESSAGES, MAX_MESSAGES);
          const messages = chat.messages.slice(-take);
          return {
            found: true as const,
            sessionId: chat.sessionId,
            ...(chat.title !== undefined ? { title: chat.title } : {}),
            updatedAt: new Date(chat.updatedAt).toISOString(),
            messageCount: chat.messageCount,
            // Flagged so the model knows the transcript is partial rather than the whole chat.
            truncated: chat.messages.length > messages.length,
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          };
        },
      });
    },
  },
});
