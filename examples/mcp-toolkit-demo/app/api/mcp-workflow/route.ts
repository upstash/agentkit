/** The MCP endpoint for the **Workflow** server. Same handler, different task layer. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../../lib/workflow-server";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(() => createServer());

export async function POST(request: Request): Promise<Response> {
  return handler.fetch(request);
}
