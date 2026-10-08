/**
 * The slice of the SDK's `AuthInfo` the toolkit reads. Typed structurally so a principal resolver
 * does not need to import the SDK's auth types.
 */
export type CallerAuth = {
  clientId?: string;
  scopes?: string[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Maps a request's auth to a stable caller id, usually your user id. `undefined` means "not
 * authenticated", and the request is refused.
 */
export type PrincipalResolver = (auth: CallerAuth | undefined) => string | undefined;

/** The `AuthInfo` an SDK request handler context carries, if any. */
export function authOf(context: unknown): CallerAuth | undefined {
  return (context as { http?: { authInfo?: CallerAuth } } | undefined)?.http?.authInfo;
}

/** Throws at construction when a layer is built without a principal. */
export function requirePrincipal(principal: unknown, layer: string): PrincipalResolver {
  if (typeof principal !== "function") {
    throw new Error(
      `${layer} needs a \`principal\`: (auth) => your user id. A server with no users of its own ` +
        'passes `principal: () => "local"`.',
    );
  }
  return principal as PrincipalResolver;
}
