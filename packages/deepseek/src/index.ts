/**
 * DeepSeek Harness plugins backed by Upstash Redis.
 *
 * The default export is the session-persistence plugin, so a `cordis.yml` row
 * can name the package directly:
 *
 * ```yaml
 * - id: session-persistence
 *   name: '@upstash/agentkit-deepseek'
 * ```
 *
 * @module @upstash/agentkit-deepseek
 */

export {
  RedisSessionPersistence,
  RedisSessionPersistence as default,
  type Config,
  type Config as RedisSessionPersistenceConfig,
} from "./session-persistence.js";
export { DEFAULT_PREFIX, sessionKeys, type SessionKeys } from "./keys.js";
export {
  DEFAULT_TOKEN_REF,
  DEFAULT_URL_REF,
  assertCredentialRef,
  credentialResolverOf,
  resolveConnection,
  type CredentialInfo,
  type CredentialResolver,
  type CredentialWriter,
  type ResolvedCredential,
} from "./credentials.js";
export {
  decodeEvent,
  decodeHeader,
  encodeEvent,
  encodeHeader,
  scanRecords,
  type ScannedRecords,
} from "./records.js";
