import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// End-to-end smoke check of the AgentKit extension on the current eve, with no model
// provider: run with AGENTKIT_MOCK_MODEL=1 so agent.ts uses the scripted mockModel, which
// calls agentkit__save_memory for real (against real Redis) and then echoes the tool
// result. Green means: the extension dist loads, its contributions mount, a session runs,
// the tool executes, and the chat_history hook has fired on the same turn.
export default defineEval({
  async test(t) {
    await t.send("Please remember my favorite color.");
    t.succeeded();
    t.calledTool("agentkit__save_memory");
    t.check(t.reply, includes("Saved:"));
  },
});
