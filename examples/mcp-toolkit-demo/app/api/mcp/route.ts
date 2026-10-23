/**
 * The MCP endpoint for the **QStash** server.
 *
 * The SDK's own `createMcpHandler`, unchanged: `tasks.register` adds the task tools and, through the
 * SDK's own extension points, the Tasks extension's `tasks/get` and `tasks/cancel`, so it needs no
 * custom transport.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveMcp } from "../../lib/auth";
import { createServer } from "../../lib/qstash-server";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(() => createServer());

export async function POST(request: Request): Promise<Response> {
  // Verifies the caller and passes `authInfo` to the SDK, which hands it to `principal`.
  return serveMcp(handler, request);
}
