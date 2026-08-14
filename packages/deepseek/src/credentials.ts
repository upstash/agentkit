/**
 * Resolving the Upstash connection through the harness's credentials seam.
 *
 * `Redis.fromEnv()` alone is not enough in a DeepSeek Harness deployment. The
 * harness has four credential layers, and the one users are steered toward —
 * the managed `$DSH_HOME/.credentials.yaml` document that the Web UI writes and
 * hot-reloads — is **deliberately never materialized into `process.env`**. It is
 * resolved by name through `ctx.credentials`. A backend that only reads the
 * environment therefore cannot see a key the user stored the recommended way.
 *
 * So the connection resolves in this order:
 *
 * 1. An explicit `redis` client from config (the runtime-only seam).
 * 2. `ctx.credentials`, when a provider is mounted — which searches every layer
 *    (inherited env > `.credentials.yaml` > project `.env` > user `.env`).
 * 3. `Redis.fromEnv()`, so a deployment with no credentials provider, or an
 *    embedder using this outside the harness, behaves exactly as before.
 *
 * The credentials service is bound structurally rather than imported, so this
 * package takes no dependency on `@deepseek-ai/dsh-credentials` and works
 * unchanged when no provider is mounted.
 *
 * @module @upstash/agentkit-deepseek/credentials
 */

/** POSIX-portable environment-variable name — the credentials seam's ref pattern. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default credential reference for the REST URL. */
export const DEFAULT_URL_REF = "UPSTASH_REDIS_REST_URL";

/** Default credential reference for the REST token. */
export const DEFAULT_TOKEN_REF = "UPSTASH_REDIS_REST_TOKEN";

/** One resolved credential and the provider-defined layer that supplied it. */
export interface ResolvedCredential {
  value: string;
  source: string;
}

/**
 * The slice of `ctx.credentials` this package uses.
 *
 * Structural on purpose: binding by shape keeps `@deepseek-ai/dsh-credentials`
 * out of the dependency graph, and the service is optional anyway.
 */
export interface CredentialResolver {
  resolve(ref: string): Promise<ResolvedCredential | undefined>;
}

/** What `describe` reports about one reference, without revealing its value. */
export interface CredentialInfo {
  configured: boolean;
  source?: string;
  writable: boolean;
}

/**
 * The write side of `ctx.credentials`, used by this package's CLI.
 *
 * `set` rejects for a reference the launching environment already supplies —
 * the provider refuses a write that a higher-precedence layer would shadow,
 * rather than storing a value the reader would never see.
 */
export interface CredentialWriter extends CredentialResolver {
  describe(ref: string): Promise<CredentialInfo>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/**
 * Validate a credential reference the same way the seam does.
 * @param ref - candidate reference, e.g. `UPSTASH_REDIS_REST_TOKEN`.
 * @returns the reference unchanged.
 * @throws when it is not a POSIX identifier, which the seam would reject later.
 */
export function assertCredentialRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new TypeError(`credential ref "${ref}" must match ${String(REF_PATTERN)}`);
  }
  return ref;
}

/**
 * Bind the credentials service if one is mounted.
 *
 * `ctx.get` returns `any` and does not throw for an absent service, so this is
 * the whole optional-service story — no injection fiber to own or dispose.
 * @param ctx - the plugin's context.
 * @returns the resolver, or `undefined` when no provider is mounted.
 */
export function credentialResolverOf(ctx: {
  get(name: string): unknown;
}): CredentialResolver | undefined {
  const service = ctx.get("credentials") as CredentialResolver | undefined;
  return typeof service?.resolve === "function" ? service : undefined;
}

/**
 * Resolve one credential pair through the service, if both are present.
 *
 * Both halves must resolve: a URL without a token (or the reverse) is a
 * half-configured deployment, and falling through to `Redis.fromEnv()` gives a
 * clearer failure than constructing a client from one good half.
 * @param resolver - the bound credentials service.
 * @param urlRef - reference holding the REST URL.
 * @param tokenRef - reference holding the REST token.
 * @returns both values, or `undefined` when either is unset.
 */
export async function resolveConnection(
  resolver: CredentialResolver,
  urlRef: string,
  tokenRef: string,
): Promise<{ url: string; token: string } | undefined> {
  const [url, token] = await Promise.all([
    resolver.resolve(assertCredentialRef(urlRef)),
    resolver.resolve(assertCredentialRef(tokenRef)),
  ]);
  if (url === undefined || token === undefined) return undefined;
  if (url.value.length === 0 || token.value.length === 0) return undefined;
  return { url: url.value, token: token.value };
}
