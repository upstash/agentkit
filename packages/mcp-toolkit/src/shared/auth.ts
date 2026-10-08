/**
 * The SDK's `AuthInfo`, typed structurally so a principal resolver needs no SDK import. It is what
 * your route passes to `handler.fetch(request, { authInfo })` after verifying the token: the SDK
 * never fills it from headers itself.
 */
export type CallerAuth = {
  token?: string;
  clientId?: string;
  scopes?: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
};

/** What `principal` is handed for each call. */
export type Caller = {
  /** The verified `AuthInfo` your route passed to the SDK, if any. Prefer this. */
  auth: CallerAuth | undefined;
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
  const http = (context as { http?: { authInfo?: CallerAuth; req?: Request } } | undefined)?.http;
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
