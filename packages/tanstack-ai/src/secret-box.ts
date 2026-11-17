// AES-256-GCM helpers shared by the stores that keep secrets at rest (BYOK credentials, MCP session
// headers). Web Crypto only, so they run on Node, edge and serverless runtimes alike.

const b64 = {
  // Chunked: spreading a large array into String.fromCharCode overflows the call stack.
  encode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return globalThis.btoa(binary);
  },
  decode: (text: string) => Uint8Array.from(globalThis.atob(text), (c) => c.charCodeAt(0)),
};

const KEY_HELP =
  "@upstash/agentkit-tanstack-ai: `encryptionKey` must be 32 bytes: a Uint8Array, or a base64, base64url or hex string (e.g. `openssl rand -base64 32`).";

/** A 32-byte key from a `Uint8Array`, or a base64 / base64url / hex string. */
function toKeyBytes(key: string | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof key !== "string") bytes = key;
  else {
    const text = key.trim();
    try {
      bytes = /^[0-9a-f]{64}$/i.test(text)
        ? Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16))
        : b64.decode(
            text
              .replace(/-/g, "+")
              .replace(/_/g, "/")
              .padEnd(Math.ceil(text.length / 4) * 4, "="),
          );
    } catch {
      throw new Error(KEY_HELP);
    }
  }
  if (bytes.length !== 32) throw new Error(KEY_HELP);
  return bytes;
}

export interface Sealed {
  /** Base64 IV. */
  iv: string;
  /** Base64 ciphertext (with the GCM tag). */
  ct: string;
}

const utf8 = new TextEncoder();

/** Seal and open JSON values with one key; `aad` binds a ciphertext to where it is stored. */
export function secretBox(key: string | Uint8Array) {
  const keyBytes = toKeyBytes(key);
  let cryptoKey: ReturnType<typeof crypto.subtle.importKey> | undefined;
  const getKey = () =>
    (cryptoKey ??= crypto.subtle.importKey("raw", keyBytes as never, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]));
  return {
    async seal(value: unknown, aad: string): Promise<Sealed> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8.encode(aad) },
        await getKey(),
        utf8.encode(JSON.stringify(value)),
      );
      return { iv: b64.encode(iv), ct: b64.encode(new Uint8Array(ct)) };
    },
    async open<T>(sealed: Sealed, aad: string): Promise<T> {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64.decode(sealed.iv), additionalData: utf8.encode(aad) },
        await getKey(),
        b64.decode(sealed.ct),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    },
  };
}
