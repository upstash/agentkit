/** The MCP endpoint for **Deploy Watch**, the events demo. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveMcp } from "../../lib/auth";
import { createServer } from "../../lib/deploy-watch";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(() => createServer());

export async function POST(request: Request): Promise<Response> {
  // Verifies the caller and passes `authInfo` to the SDK, which hands it to `principal`.
  return serveMcp(handler, request);
}
