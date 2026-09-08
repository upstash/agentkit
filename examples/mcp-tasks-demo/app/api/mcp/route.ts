/**
 * The MCP endpoint for the **QStash** server.
 *
 * Note this uses `WebStandardStreamableHTTPServerTransport` rather than `createMcpHandler`. Both
 * take a web `Request` and return a `Response`, but `createMcpHandler` pins the request to the
 * 2026-07-28 era, and on that era the SDK's dispatch gate answers `tasks/get` and `tasks/cancel`
 * with `-32601` before your handler is ever looked up. See `TASK_METHODS` in `@upstash/mcp-tasks`.
 */
import { createServer } from "../../lib/qstash-server";
import { serveMcp } from "../../lib/serve-mcp";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return serveMcp(createServer(), request);
}
