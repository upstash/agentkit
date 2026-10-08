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
export const SECRET_MIN_BYTES = 24;
export const SECRET_MAX_BYTES = 64;

/** The key bytes of a `whsec_<base64>` secret, or `null` when malformed or outside 24–64 bytes. */
export function decodeSecret(secret: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const body = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(body);
  } catch {
    return null;
  }
  return bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES ? bytes : null;
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
 * cannot forge events. Any string works as the key; it is hashed to 32 bytes. Rotating it makes
 * stored secrets unreadable, and hosts re-verify on their next refresh.
 */
export class SecretBox {
  private readonly key: Promise<AesKey>;

  constructor(secretKey: string) {
    if (!secretKey) throw new Error("SecretBox needs a non-empty secretKey");
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

  async open(sealed: string): Promise<string> {
    const [version, iv, payload] = sealed.split(".");
    if (version !== "v1" || !iv || !payload) throw new Error("Unrecognized sealed secret");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) },
      await this.key,
      fromBase64(payload),
    );
    return fromUtf8(new Uint8Array(plain));
  }
}

/**
 * Why a callback URL is refused, or `null` when it is acceptable. Refuses non-HTTPS, credentials,
 * and hosts on the server's own network: `localhost`, single-label, `.local` / `.internal`, and
 * private or reserved IP literals. It does not resolve DNS, so add egress filtering in production.
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

  // `localhost.` resolves like `localhost`, so trailing dots go before any check.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[")) {
    return isPrivateV6(host.slice(1, -1)) ? "callback URL must be a public host" : null;
  }
  // The URL parser has already normalized every IPv4 form (hex, octal, short) to dotted decimal.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isPrivateV4(host.split(".").map(Number)) ? "callback URL must be a public host" : null;
  }
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

function isPrivateV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparseable: refuse
  const v4 = (hi: number, lo: number) => isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!); // IPv4-mapped
  if (zero(0, 6)) return v4(g[6]!, g[7]!); // IPv4-compatible, plus :: and ::1
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (zero(2, 6)) return v4(g[6]!, g[7]!); // NAT64 64:ff9b::/96
    if (g[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  }
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g[0]! & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g[0]! & 0xff00) === 0xff00 || // multicast ff00::/8
    (g[0] === 0x2001 && g[1] === 0x0db8) // documentation 2001:db8::/32
  );
}

/** Expands a compressed IPv6 address (as the URL parser prints it) to eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : [];
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<number>(Math.max(missing, 0)).fill(0), ...tail];
  return groups.some(Number.isNaN) ? null : groups;
}

/** POSTs a signed JSON body to a callback, never following redirects. */
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
