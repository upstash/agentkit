import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { searchDefs, trySearchDefs } from "../lib/runtime";

/**
 * Dynamic rather than static: the tool's description and input schema are derived from the
 * consumer's `search.schema` (they teach the model the index fields and which filter operators
 * apply), and that config is only bound at runtime — a `session.started` resolver sees it, a
 * static module evaluated at discovery doesn't. Unconfigured → `null`, so the tool simply
 * doesn't exist instead of erroring at call time.
 *
 * The input schema is handed to eve as plain JSON Schema, not as the live zod object core builds:
 * eve ≥0.59 replays dynamic tools from a durable snapshot, so a live schema captured from the
 * resolver is rejected at resolution ("non-serializable capture") and the tool silently never
 * mounts. Plain JSON Schema data needs no durable factory — eve rehydrates it into its own
 * validator — and `z.toJSONSchema` keeps every field description the model is taught with.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      const defs = trySearchDefs();
      if (!defs) return null;
      // Plain JSON data, computed here so the schema factory's closure holds only that (see above).
      const inputSchema = z.toJSONSchema(defs.search.inputSchema);
      return defineTool({
        description: defs.search.description,
        inputSchema,
        execute: (input: Record<string, unknown>) => searchDefs().search.execute(input),
      });
    },
  },
});
