import { defineDynamic, defineTool } from "eve/tools";
import { searchDefs, trySearchDefs } from "../lib/runtime";

// Dynamic for the same reason as `search`: the schema-derived description/input schema need the
// runtime-bound mount config. See tools/search.ts.
export default defineDynamic({
  events: {
    "session.started": () => {
      const defs = trySearchDefs();
      if (!defs) return null;
      return defineTool({
        description: defs.aggregate.description,
        inputSchema: defs.aggregate.inputSchema,
        execute: (input: Record<string, unknown>) => searchDefs().aggregate.execute(input),
      });
    },
  },
});
