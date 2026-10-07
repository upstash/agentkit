import { defineTool } from "eve/tools";
import { z } from "zod";
import extension from "../extension";
import { memory, resolveUserId } from "../lib/runtime";

export default defineTool({
  description:
    "Recall the user's long-term memories. Pass `query` to find memories about a specific topic. " +
    "To list ALL of the user's memories, call this with NO `query` at all — do not pass a " +
    'placeholder like "everything" or "all".',
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Topic or keywords to search memories for. Leave this out entirely to return every " +
          "stored memory for the user.",
      ),
  }),
  async execute({ query }, ctx) {
    const { topK, minScore } = extension.config.memory ?? {};
    // A query that matches nothing returns nothing — `recall()` has no "everything for the
    // user" fallback, because a miss answered with unrelated memories reads as a hit.
    const hits = await memory().recall({
      query,
      userId: resolveUserId(ctx),
      ...(topK !== undefined ? { topK } : {}),
      ...(minScore !== undefined ? { minScore } : {}),
    });
    return hits.map((hit) => ({ text: hit.text, score: hit.score }));
  },
});
