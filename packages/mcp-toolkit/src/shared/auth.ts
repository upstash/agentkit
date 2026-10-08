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
 * The caller's id, or the id plus non-secret context (an org id, a role) that event subscriptions
 * store and hand back to `authorize` before each delivery. Never put the token in it.
 */
export type Principal = string | { id: string; context?: Record<string, unknown> };

/**
 * Maps a call to a stable caller id, usually your user id. It must return one: when it cannot
 * identify the caller, throw, and the call is refused as not authenticated. May be async, e.g. to
 * look up a session.
 */
export type PrincipalResolver = (caller: Caller) => Principal | Promise<Principal>;

/** The most JSON a principal's context may take, since it is stored with every subscription. */
export const MAX_CONTEXT_BYTES = 4096;

/** The auth and request an SDK request handler context carries. */
export function callerOf(context: unknown): Caller {
  const http = (context as { http?: { authInfo?: CallerAuth; req?: Request } } | undefined)?.http;
  return { auth: http?.authInfo, request: http?.req };
}

/**
 * Runs the resolver and normalizes its answer to `{ id, context }`. Fails closed: a throw, or an
 * answer without a non-empty string id (from an `as string` that lied, or plain JavaScript),
 * gives `undefined`, which the layers refuse as not authenticated.
 */
export async function resolvePrincipal(
  principal: PrincipalResolver,
  caller: Caller,
): Promise<{ id: string; context: Record<string, unknown> } | undefined> {
  let result: unknown;
  try {
    result = await principal(caller);
  } catch {
    return undefined;
  }
  const id = typeof result === "string" ? result : (result as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "") return undefined;
  if (typeof result === "string") return { id, context: {} };
  const context = (result as { context?: Record<string, unknown> }).context ?? {};
  if (new TextEncoder().encode(JSON.stringify(context)).length > MAX_CONTEXT_BYTES) {
    throw new Error(`principal context must be at most ${MAX_CONTEXT_BYTES} bytes of JSON`);
  }
  return { id, context };
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
