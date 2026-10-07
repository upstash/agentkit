/**
 * The MCP endpoint for the **QStash** server.
 *
 * The SDK's own `createMcpHandler`, unchanged: the task layer only registers ordinary tools, so it
 * needs no custom transport and no extra protocol methods.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../../lib/qstash-server";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(() => createServer());

export async function POST(request: Request): Promise<Response> {
  return handler.fetch(request);
}
