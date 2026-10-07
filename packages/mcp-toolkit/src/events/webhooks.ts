/**
 * The webhook plumbing MCP Events needs:
 *
 * - Standard Webhooks signing (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 * - Encrypting the host's signing secret at rest (AES-256-GCM).
 * - Checking a callback URL before the server ever POSTs to it.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";

/** The secret length the MCP Events draft allows, in decoded bytes. */
export const SECRET_MIN_BYTES = 24;
export const SECRET_MAX_BYTES = 64;

/**
 * Decodes a `whsec_<base64>` secret into its key bytes, or returns `null` when it is malformed or
 * outside the 24–64 byte range the draft allows.
 */
export function decodeSecret(secret: unknown): Buffer | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const body = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const bytes = Buffer.from(body, "base64");
  if (bytes.length < SECRET_MIN_BYTES || bytes.length > SECRET_MAX_BYTES) return null;
  return bytes;
}

/**
 * Signs a webhook body the Standard Webhooks way: base64 HMAC-SHA256 over
 * `${id}.${timestamp}.${body}`, sent as `v1,<signature>`.
 *
 * Returns the three headers to send. `timestampSeconds` defaults to now; every attempt should be
 * signed fresh, because receivers reject stale timestamps.
 */
export async function signWebhook(
  secret: string,
  id: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>> {
  const key = decodeSecret(secret);
  if (!key) throw new Error("Invalid webhook secret");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestampSeconds}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": `v1,${signature}`,
  };
}

/**
 * Verifies a Standard Webhooks signature, with a tolerance on the timestamp. Exported for tests
 * and for anyone writing a receiver; the server side of MCP Events only signs.
 */
export async function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  if (!decodeSecret(secret)) return false;
  const expected = (await signWebhook(secret, id, body, ts))["webhook-signature"];
  // Several space-separated signatures are allowed (key rotation).
  return signature.split(" ").some((candidate) => safeEqual(candidate, expected));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Encrypts and decrypts the hosts' signing secrets with a server-side key, so a leaked database
 * dump cannot be used to forge events.
 *
 * The key can be any string (it is hashed to 32 bytes); generate one with
 * `openssl rand -base64 32`. Rotating it invalidates stored subscriptions, which hosts recreate
 * on their next refresh.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secretKey: string) {
    if (!secretKey) throw new Error("SecretBox needs a non-empty secretKey");
    this.key = createHash("sha256").update(secretKey).digest();
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64")}.${Buffer.concat([data, tag]).toString("base64")}`;
  }

  open(sealed: string): string {
    const [version, iv, payload] = sealed.split(".");
    if (version !== "v1" || !iv || !payload) throw new Error("Unrecognized sealed secret");
    const bytes = Buffer.from(payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }
}

/**
 * Why a callback URL was refused, or `null` when it is acceptable.
 *
 * The server POSTs to a URL a client chose, which is the textbook server-side request forgery
 * setup. This refuses non-HTTPS URLs, credentials in the URL, and hosts that name the server's own
 * network: `localhost`, single-label, `.local` / `.internal` names, and private, loopback,
 * link-local and carrier-NAT IP literals. Redirects are never followed when posting.
 *
 * It does not resolve DNS, so a public name that resolves to a private address is not caught
 * here. If your server runs next to sensitive internal services, put egress filtering in front of
 * it as well.
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
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipVersion = isIP(host);
  if (ipVersion !== 0) return isPrivateAddress(host) ? "callback URL must be a public host" : null;
  if (
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return "callback URL must be a public host";
  }
  return null;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const dotted = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (dotted?.[1]) return isPrivateV4(dotted[1]);
  // The URL parser normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1.
  const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // fc00::/7 unique local
    /^fe[89ab]/.test(v6) // fe80::/10 link-local
  );
}

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** POSTs a signed JSON body to a callback, without following redirects. */
export async function postSigned(options: {
  url: string;
  secret: string;
  webhookId: string;
  body: string;
  subscriptionId: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Promise<Response> {
  const headers = await signWebhook(options.secret, options.webhookId, options.body);
  return await (options.fetch ?? fetch)(options.url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      "content-type": "application/json",
      "x-mcp-subscription-id": options.subscriptionId,
      ...headers,
    },
    body: options.body,
  });
}
