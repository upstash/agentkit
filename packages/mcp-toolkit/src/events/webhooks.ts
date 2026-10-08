/**
 * Webhook plumbing for MCP Events: Standard Webhooks signing, the host secret encrypted at rest,
 * and the checks a callback URL must pass before the server POSTs to it.
 */
import {
  constantTimeEqual,
  fromBase64,
  fromUtf8,
  randomBytes,
  sha256,
  toBase64,
  utf8,
} from "../shared/crypto.js";

/** The secret length the MCP Events draft allows, in decoded bytes. */
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;
/** The least random key material `SecretBox` accepts, in decoded bytes. */
const SECRET_KEY_MIN_BYTES = 32;

/** The key bytes of a `whsec_<base64>` secret, or `null` when malformed or outside 24–64 bytes. */
export function decodeSecret(secret: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const bytes = decodeBase64(secret.slice("whsec_".length));
  return bytes && bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES
    ? bytes
    : null;
}

/**
 * Signs a body the Standard Webhooks way: base64 HMAC-SHA256 over `${id}.${timestamp}.${body}`,
 * sent as `v1,<signature>`. Sign every attempt fresh: receivers reject stale timestamps.
 */
export async function signWebhook(
  secret: string,
  id: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>> {
  const key = decodeSecret(secret);
  if (!key) throw new Error("Invalid webhook secret");
  const hmac = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    hmac,
    utf8(`${id}.${timestampSeconds}.${body}`),
  );
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": `v1,${toBase64(new Uint8Array(signature))}`,
  };
}

/** Verifies a Standard Webhooks signature, for receivers and tests. */
export async function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature || !decodeSecret(secret)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = (await signWebhook(secret, id, body, ts))["webhook-signature"];
  // Several space-separated signatures are allowed, for key rotation.
  return signature.split(" ").some((candidate) => constantTimeEqual(candidate, expected));
}

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * Encrypts the hosts' signing secrets with a server-side key (AES-256-GCM), so a leaked database
 * cannot forge events. The key is base64 of at least 32 random bytes (`openssl rand -base64 32`).
 * Rotating it makes stored secrets unreadable, and hosts re-verify on their next refresh.
 */
export class SecretBox {
  private readonly key: Promise<AesKey>;

  constructor(secretKey: string) {
    if ((decodeBase64(secretKey)?.length ?? 0) < SECRET_KEY_MIN_BYTES) {
      throw new Error(
        "The events secretKey must be base64 of at least 32 random bytes. Generate one with: openssl rand -base64 32",
      );
    }
    this.key = sha256(secretKey).then((raw) =>
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
    );
  }

  async seal(plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.key,
      utf8(plaintext),
    );
    return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
  }

  /** The secret, or `null` when it was sealed under another key or has been tampered with. */
  async open(sealed: string): Promise<string | null> {
    const [version, iv, payload] = sealed.split(".");
    if (version !== "v1" || !iv || !payload) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(iv) },
        await this.key,
        fromBase64(payload),
      );
      return fromUtf8(new Uint8Array(plain));
    } catch {
      return null;
    }
  }
}

/**
 * Why a callback URL is refused, or `null` when it is acceptable. Refuses non-HTTPS, credentials,
 * every IP literal, and names on the server's own network: `localhost`, single-label hosts,
 * `.local` and `.internal`. It does not resolve DNS, so add egress filtering in production.
 */
export function callbackUrlProblem(raw: unknown, allowInsecure = false): string | null {
  if (typeof raw !== "string") return "callback URL is missing";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "callback URL is not a valid URL";
  }
  if (allowInsecure) {
    return url.protocol === "https:" || url.protocol === "http:"
      ? null
      : "callback URL must be http(s)";
  }
  if (url.protocol !== "https:") return "callback URL must use https";
  if (url.username || url.password) return "callback URL must not contain credentials";

  // `localhost.` resolves like `localhost`, so trailing dots go before any check. The URL parser
  // has already normalized every IPv4 form (hex, octal, short) to dotted decimal.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const ipLiteral = host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (
    ipLiteral ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return "callback URL must be a public host name";
  }
  return null;
}

/** POSTs a signed JSON body to a callback, never following redirects. */
export async function postSigned(options: {
  url: string;
  secret: string;
  webhookId: string;
  body: string;
  subscriptionId: string;
}): Promise<Response> {
  const headers = await signWebhook(options.secret, options.webhookId, options.body);
  return await fetch(options.url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-mcp-subscription-id": options.subscriptionId,
      ...headers,
    },
    body: options.body,
  });
}

/** How long a callback gets to answer one POST. */
const CALLBACK_TIMEOUT_MS = 10_000;

/** Reads at most `maxBytes` of a response body, then drops the rest. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = chunk.subarray(0, bytes.length - offset);
    bytes.set(take, offset);
    offset += take.length;
    if (offset >= bytes.length) break;
  }
  return fromUtf8(bytes);
}

/** Strict standard base64, or `null`. */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    return fromBase64(value);
  } catch {
    return null;
  }
}
