import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// AGENTKIT_MOCK_MODEL switches to a deterministic scripted model so the e2e eval
// (evals/memory.eval.ts) can exercise the real memory slots — which hit real Redis — without
// calling a model provider. Unset, the demo talks to OpenAI as usual.
//
// The script is prompt-aware: eve injects each memory slot's recalled context as messages *before*
// the model call, so echoing what arrived in the prompt is what proves automatic recall works end
// to end. Two prefixes drive the save tools, one per slot. `redisMemory()` also captures the
// caller's messages automatically (`rememberMessages` defaults to `true`, i.e. `"fromUser"`), but
// automatic recall injects curated facts only, so what these save tools store is what comes back:
//
//   "REMEMBER: <fact>" → `profile__save_memory` (eve's own file memory, our Redis storage)
//   "NOTE: <fact>"     → `recall__save_memory`  (our MemoryProvider)
//
// Note `toolResults` lists every tool result in the *prompt*, not just this turn's, so the script
// counts requests against completed saves rather than testing for "any tool result".
export default defineAgent({
  model: process.env.AGENTKIT_MOCK_MODEL
    ? mockModel(({ messages, toolResults, userMessages }) => {
        for (const [prefix, tool] of [
          ["REMEMBER:", "profile__save_memory"],
          ["NOTE:", "recall__save_memory"],
        ] as const) {
          const asked = userMessages.filter((m) => m.startsWith(prefix));
          const saved = toolResults.filter((r) => r.name === tool);
          if (asked.length > saved.length) {
            return {
              toolCalls: [
                { name: tool, input: { text: asked[asked.length - 1]!.slice(prefix.length).trim() } },
              ],
            };
          }
        }
        // Echo the recalled memory blocks eve put in the prompt so the eval can assert on them.
        const recalled = messages
          .filter((m) => m.text.includes("memories for"))
          .map((m) => m.text)
          .join("\n---\n");
        return `RECALLED>>>\n${recalled || "(nothing)"}`;
      })
    : openai("gpt-5.4-mini"),
  // The mock model has no AI Gateway metadata, so give compaction an explicit window.
  ...(process.env.AGENTKIT_MOCK_MODEL ? { modelContextWindowTokens: 128_000 } : {}),
});
