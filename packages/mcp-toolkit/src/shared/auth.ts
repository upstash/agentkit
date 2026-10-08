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
  [key: string]: unknown;
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
 * Maps a call to a stable caller id, usually your user id. `undefined` means "not
 * authenticated", and the call is refused. May be async, e.g. to look up a session.
 */
export type PrincipalResolver = (
  caller: Caller,
) => string | undefined | Promise<string | undefined>;

/** The auth and request an SDK request handler context carries. */
export function callerOf(context: unknown): Caller {
  const http = (context as { http?: { authInfo?: CallerAuth; req?: Request } } | undefined)?.http;
  return { auth: http?.authInfo, request: http?.req };
}

/** Throws at construction when a layer is built without a principal. */
export function requirePrincipal(principal: unknown, layer: string): PrincipalResolver {
  if (typeof principal !== "function") {
    throw new Error(
      `${layer} needs a \`principal\`: ({ auth }) => your user id. A server with no users of its ` +
        'own passes `principal: () => "local"`.',
    );
  }
  return principal as PrincipalResolver;
}
