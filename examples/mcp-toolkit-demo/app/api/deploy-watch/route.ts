/** The MCP endpoint for **Deploy Watch**, the events demo. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../../lib/deploy-watch";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(() => createServer());

export async function POST(request: Request): Promise<Response> {
  return handler.fetch(request);
}
