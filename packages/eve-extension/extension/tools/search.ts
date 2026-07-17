import { defineDynamic, defineTool } from "eve/tools";
import { searchDefs, trySearchDefs } from "../lib/runtime";

/**
 * Dynamic rather than static: the tool's description and input schema are derived from the
 * consumer's `search.schema` (they teach the model the index fields and which filter operators
 * apply), and that config is only bound at runtime — a `session.started` resolver sees it, a
 * static module evaluated at discovery doesn't. Unconfigured → `null`, so the tool simply
 * doesn't exist instead of erroring at call time.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      const defs = trySearchDefs();
      if (!defs) return null;
      return defineTool({
        description: defs.search.description,
        inputSchema: defs.search.inputSchema,
        execute: (input: Record<string, unknown>) => searchDefs().search.execute(input),
      });
    },
  },
});
