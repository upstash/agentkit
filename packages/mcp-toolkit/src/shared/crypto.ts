/** Runtime-neutral crypto and encoding helpers on WebCrypto, so the package runs on Node and edge. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(text) as Uint8Array<ArrayBuffer>;

export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/** Decodes standard base64. Throws on invalid input. */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const randomBytes = (length: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(length));

export const randomHex = (length: number): string => toHex(randomBytes(length));

export const randomBase64Url = (length: number): string =>
  toBase64(randomBytes(length)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sha256(input: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(input)));
}

export const sha256Hex = async (input: string): Promise<string> => toHex(await sha256(input));

/** Compares two strings in time independent of where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
