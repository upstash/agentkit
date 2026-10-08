import type { AuthInfo } from "@modelcontextprotocol/server";

/** What `principal` is handed for each call. */
export type Caller = {
  /**
   * The SDK's `AuthInfo`: what your route passed to `handler.fetch(request, { authInfo })` after
   * verifying the token, if anything. The SDK never fills it from headers. Prefer this.
   */
  auth: AuthInfo | undefined;
  /**
   * The raw HTTP request, for apps that authenticate with a cookie or session. It is unverified:
   * check the session yourself, and never trust a header like `x-user-id` the caller can set.
   */
  request: Request | undefined;
};

/**
 * Maps a call to a stable caller id, usually your user id. It must return one: when it cannot
 * identify the caller, throw, and the call is refused as not authenticated. May be async, e.g. to
 * look up a session.
 */
export type PrincipalResolver = (caller: Caller) => string | Promise<string>;

/** The auth and request an SDK request handler context carries. */
export function callerOf(context: unknown): Caller {
  const http = (context as { http?: { authInfo?: AuthInfo; req?: Request } } | undefined)?.http;
  return { auth: http?.authInfo, request: http?.req };
}

/**
 * Runs the resolver. Fails closed: a throw, or anything but a non-empty string (an `as string`
 * that lied, or plain JavaScript), gives `undefined`, which the layers refuse as not authenticated.
 */
export async function resolvePrincipal(
  principal: PrincipalResolver,
  caller: Caller,
): Promise<string | undefined> {
  try {
    const id: unknown = await principal(caller);
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Throws at construction when a layer is built without a principal. */
export function requirePrincipal(principal: unknown, layer: string): PrincipalResolver {
  if (typeof principal !== "function") {
    throw new Error(
      `${layer} needs a \`principal\` that returns your user id (and throws when it can't). A server with no users of its ` +
        'own passes `principal: () => "local"`.',
    );
  }
  return principal as PrincipalResolver;
}
