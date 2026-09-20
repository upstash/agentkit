import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// AGENTKIT_MOCK_MODEL switches to a deterministic scripted model so the e2e eval
// (evals/agentkit-smoke.eval.ts) can exercise the extension's real tools — which hit real
// Redis — without calling a model provider. Unset, the demo talks to OpenAI as usual.
//
// The script is two tool calls, then an echo: `agentkit__save_memory` (a static tool) and
// `agentkit__search_count` (a DYNAMIC tool, resolved at session start from the mount's `search`
// config). The second one is the guard that matters: `eve build` checks the manifest but never
// resolves dynamic tools, so a dynamic tool eve rejects at runtime just logs and vanishes — only
// a turn that calls it proves it mounted. `toolResults` lists every result in the prompt so far.
export default defineAgent({
  model: process.env.AGENTKIT_MOCK_MODEL
    ? mockModel(({ toolResults }) => {
        if (toolResults.length === 0) {
          return {
            toolCalls: [
              { name: "agentkit__save_memory", input: { text: "The user's favorite color is teal." } },
            ],
          };
        }
        if (toolResults.length === 1) {
          return { toolCalls: [{ name: "agentkit__search_count", input: {} }] };
        }
        return `Saved: ${JSON.stringify(toolResults[0]?.output)}`;
      })
    : openai("gpt-5.4-mini"),
  // The mock model has no AI Gateway metadata, so give compaction an explicit window.
  ...(process.env.AGENTKIT_MOCK_MODEL ? { modelContextWindowTokens: 128_000 } : {}),
});
