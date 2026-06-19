import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

// Rate limiting is enforced at the channel's auth walk (see agent/channels/eve.ts),
// so the model is plain here. `defineAgent` accepts a gateway model id string or a
// provider-authored AI SDK `LanguageModel`.
export default defineAgent({
  model: openai("gpt-5.4-mini"),
});
