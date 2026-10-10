// Encoding and signature primitives on WebCrypto only (no npm deps), so the
// same code runs in the Worker and in the vitest suite on Node.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function randomId(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

/** Constant-time compare for short strings (cookie signatures). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, utf8(data));
  return b64url(new Uint8Array(sig));
}

/** Split a compact JWT without verifying anything. */
export function splitJwt(jwt: string): { header: any; payload: any; signingInput: Uint8Array; signature: Uint8Array } | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(fromUtf8(unb64url(parts[0])));
    const payload = JSON.parse(fromUtf8(unb64url(parts[1])));
    return { header, payload, signingInput: utf8(`${parts[0]}.${parts[1]}`), signature: unb64url(parts[2]) };
  } catch {
    return null;
  }
}

/** Verify an EdDSA (Ed25519) JWT signature against an OKP JWK. */
export async function verifyEd25519(jwk: JsonWebKey, signingInput: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") return false;
  if (signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signingInput);
  } catch {
    return false;
  }
}

/** Verify an RS256 JWT signature against an RSA JWK (Google id tokens). */
export async function verifyRs256(jwk: JsonWebKey, signingInput: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (jwk.kty !== "RSA") return false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput);
  } catch {
    return false;
  }
}
