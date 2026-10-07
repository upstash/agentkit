import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { searchDefs, trySearchDefs } from "../lib/runtime";

// Dynamic for the same reason as `search`: the schema-derived description/input schema need the
// runtime-bound mount config. See tools/search.ts.
export default defineDynamic({
  events: {
    "session.started": () => {
      const defs = trySearchDefs();
      if (!defs) return null;
      // Plain JSON data, computed here so the schema factory's closure holds only that (see tools/search.ts).
      const inputSchema = z.toJSONSchema(defs.aggregate.inputSchema);
      return defineTool({
        description: defs.aggregate.description,
        inputSchema,
        execute: (input: Record<string, unknown>) => searchDefs().aggregate.execute(input),
      });
    },
  },
});
