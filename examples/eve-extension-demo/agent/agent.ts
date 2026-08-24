import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// AGENTKIT_MOCK_MODEL switches to a deterministic scripted model so the e2e eval
// (evals/agentkit-smoke.eval.ts) can exercise the extension's real tools — which hit real
// Redis — without calling a model provider. Unset, the demo talks to OpenAI as usual.
export default defineAgent({
  model: process.env.AGENTKIT_MOCK_MODEL
    ? mockModel(({ toolResults }) =>
        toolResults.length === 0
          ? { toolCalls: [{ name: "agentkit__save_memory", input: { text: "The user's favorite color is teal." } }] }
          : `Saved: ${JSON.stringify(toolResults[0]?.output)}`,
      )
    : openai("gpt-5.4-mini"),
  // The mock model has no AI Gateway metadata, so give compaction an explicit window.
  ...(process.env.AGENTKIT_MOCK_MODEL ? { modelContextWindowTokens: 128_000 } : {}),
});
