/**
 * The demo's stand-in for real authentication (Clerk, WorkOS, Auth0, your own).
 *
 * - `Authorization: Bearer demo-<name>` signs in as the user `demo-<name>`, so the e2e script can act
 *   as several users and check that they can't see each other's tasks.
 * - No header at all is the shared `demo-user`, so the browser page and an unauthenticated ChatGPT
 *   connection keep working.
 * - Any other header is refused with 401.
 *
 * A real server verifies a real token here, and answers 401 when there is none.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";

const DEMO_TOKEN = /^Bearer (demo-[a-z0-9-]{1,32})$/;

/** The verified caller, or `null` when the request carries a token we don't accept. */
export function verifyDemoToken(request: Request): AuthInfo | null {
  const header = request.headers.get("authorization");
  const userId = header === null ? "demo-user" : DEMO_TOKEN.exec(header)?.[1];
  if (!userId) return null;
  return { token: header ?? "anonymous", clientId: "mcp-toolkit-demo", scopes: [], extra: { userId } };
}

/** `principal` for both layers: the user id `verifyDemoToken` put in `extra`. */
export function principal({ auth }: { auth?: AuthInfo }): string {
  const userId = auth?.extra?.userId;
  if (typeof userId !== "string") throw new Error("Not authenticated");
  return userId;
}

/** Verifies the caller and hands the request to an MCP handler, or answers 401. */
export async function serveMcp(
  handler: { fetch(request: Request, options: { authInfo: AuthInfo }): Promise<Response> },
  request: Request,
): Promise<Response> {
  const authInfo = verifyDemoToken(request);
  if (!authInfo) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  return handler.fetch(request, { authInfo });
}
