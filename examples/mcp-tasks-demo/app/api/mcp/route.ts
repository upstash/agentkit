/**
 * The MCP endpoint.
 *
 * Note this uses `WebStandardStreamableHTTPServerTransport` rather than `createMcpHandler`. Both
 * take a web `Request` and return a `Response`, but `createMcpHandler` pins the request to the
 * 2026-07-28 era, and on that era the SDK's dispatch gate answers `tasks/get` and `tasks/cancel`
 * with `-32601` before your handler is ever looked up. See `TASK_METHODS` in `@upstash/mcp-tasks`
 * for the details and the namespaced-method workaround.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createServer } from "../../lib/tasks";

// Every request builds its own server and transport: the protocol is stateless now, so there is
// nothing to keep between requests, and any instance can serve any request.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    // No SSE stream here, so a keepalive would only leak a timer per request.
    keepAliveMs: 0,
  });
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);
    // Buffer the body before closing, so the response cannot be cut off by the close below.
    const body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    await transport.close();
  }
}
