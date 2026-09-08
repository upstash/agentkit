/** The MCP endpoint for the **Workflow** server. Same transport, different task layer. */
import { createServer } from "../../lib/workflow-server";
import { serveMcp } from "../../lib/serve-mcp";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return serveMcp(createServer(), request);
}
