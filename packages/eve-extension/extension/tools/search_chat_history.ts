import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { chatHistory, requireChatHistory, resolveUserId, sanitizeId } from "../lib/runtime";

/**
 * Dynamic rather than static: chat history is off by default, and whether it's enabled is only known
 * once the mount config binds at runtime. Disabled → the resolver returns `null` and the tool simply
 * doesn't exist, instead of erroring when the model calls it.
 *
 * `userId` is pinned server-side from the session (never model input), so a search can only ever
 * reach the current user's own transcripts.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      if (!chatHistory()) return null;
      return defineTool({
        description:
          "Search this user's PAST conversations (previous sessions) by what was said, and return " +
          "the matching chats — id, title, when it happened, message count — most relevant first. " +
          "Use it when the user refers to an earlier conversation ('what did we decide about X?'). " +
          "The current conversation is excluded; read a match in full with the chat-history read tool.",
        inputSchema: z.object({
          query: z
            .string()
            .min(1)
            .describe("Topic or keywords to look for in past conversations (typo-tolerant)."),
          target: z
            .enum(["user", "model", "both"])
            .optional()
            .describe(
              "Which side of the conversation to match: what the user said, what you replied, " +
                "or both (the default).",
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(50)
            .optional()
            .describe("Max chats to return. Defaults to 10."),
        }),
        async execute({ query, target, limit }, ctx) {
          const hits = await requireChatHistory().searchChats({
            userId: resolveUserId(ctx),
            query,
            limit: limit ?? 10,
            ...(target !== undefined ? { target } : {}),
          });
          // The live session is itself indexed (the hook writes as it streams), and its text is
          // already in context — so drop it and keep the tool about *past* conversations.
          const currentSessionId = sanitizeId(ctx.session.id);
          return hits
            .filter((hit) => hit.sessionId !== currentSessionId)
            .map((hit) => ({
              sessionId: hit.sessionId,
              ...(hit.title !== undefined ? { title: hit.title } : {}),
              updatedAt: new Date(hit.updatedAt).toISOString(),
              messageCount: hit.messageCount,
              score: hit.score,
            }));
        },
      });
    },
  },
});
