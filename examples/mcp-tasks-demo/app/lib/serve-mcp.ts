/** Serves one stateless MCP request against a freshly built server. Shared by both endpoints. */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";

export async function serveMcp(server: McpServer, request: Request): Promise<Response> {
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
