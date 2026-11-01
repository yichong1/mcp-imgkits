import { KEY_PREFIX_HEX_CHARS, KEY_RANDOM_BYTES } from "./constants";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function maskId(id: string): string {
  const tail = id.slice(-4);
  return `***${tail}`;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function keyPrefixFromPlaintext(plaintext: string): string {
  return plaintext.slice(0, "sk_live_".length + KEY_PREFIX_HEX_CHARS);
}

export function isWellFormedKey(token: string): boolean {
  return /^sk_live_[0-9a-f]{64}$/.test(token);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return toHex(new Uint8Array(digest));
}

export function generateApiKey(): { plaintext: string; prefix: string } {
  const bytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  const plaintext = `sk_live_${toHex(bytes)}`;
  return { plaintext, prefix: keyPrefixFromPlaintext(plaintext) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeKeyMaterial(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  return base64ToBytes(trimmed);
}

export async function importTicketKey(secret: string): Promise<CryptoKey> {
  const raw = decodeKeyMaterial(secret);
  if (raw.byteLength !== 32) {
    throw new Error("ticket_key_length");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptTicket(
  secret: string,
  ticket: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importTicketKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(ticket));
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptTicket(secret: string, ciphertext: string, iv: string): Promise<string> {
  const key = await importTicketKey(secret);
  const ivBytes = base64ToBytes(iv);
  if (ivBytes.byteLength !== 12) throw new Error("ticket_iv_length");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    base64ToBytes(ciphertext),
  );
  return textDecoder.decode(plain);
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(a)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(b)),
  ]);
  const left = new Uint8Array(digestA);
  const right = new Uint8Array(digestB);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
