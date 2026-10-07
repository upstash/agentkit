import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// End-to-end smoke check of the AgentKit extension on the current eve, with no model
// provider: run with AGENTKIT_MOCK_MODEL=1 so agent.ts uses the scripted mockModel, which
// calls agentkit__save_memory and agentkit__search_count for real (against real Redis) and
// then echoes the first tool result. Green means: the extension dist loads, its static AND
// dynamic contributions mount, a session runs, both tools execute, and the chat_history hook
// has fired on the same turn.
//
// eve ≥0.59 eval API: `t.send` opens a fresh session and resolves to the settled turn, which
// carries the reply (`turn.message`) and its own assertion scope.
export default defineEval({
  async test(t) {
    const turn = await t.send("Please remember my favorite color.");
    turn.succeeded();
    turn.calledTool("agentkit__save_memory");
    // The dynamic search tools are resolved at session start; a schema eve cannot replay makes
    // the resolver fail and the tools silently disappear, which `eve build` does not catch.
    turn.calledTool("agentkit__search_count");
    t.check(turn.message, includes("Saved:"));
  },
});
