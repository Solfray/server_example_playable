// The standalone session cookie, for people who open the page on its own
// (not inside Solfray) and sign in with Google.
//
// Format: base64url(JSON).base64url(HMAC-SHA256(SESSION_SECRET, JSON)).
// Short-lived state for the OAuth dance uses the same scheme.
//
// SOLFRAY TIE-IN: this cookie is deliberately irrelevant inside Solfray. It is
// SameSite=Lax, so the browser never sends it from Solfray's cross-site
// iframe, and the page does not need it there: identity inside Solfray is the
// playable token (auth/solfray.ts). The two identity paths never mix.

import { b64url, fromUtf8, hmacSign, timingSafeEqual, unb64url, utf8 } from "./crypto";

export const SESSION_COOKIE = "rb_session";
export const OAUTH_COOKIE = "rb_oauth";
export const SESSION_TTL_S = 30 * 24 * 3600;

export interface SessionPayload {
  /** "google:<sub>" */
  uid: string;
  display: string;
  picture?: string;
  exp: number; // unix seconds
}

export async function sealCookie(secret: string, payload: object): Promise<string> {
  const body = b64url(utf8(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export async function openCookie<T extends { exp: number }>(secret: string, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const i = value.indexOf(".");
  if (i < 0) return null;
  const body = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expect = await hmacSign(secret, body);
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const p = JSON.parse(fromUtf8(unb64url(body))) as T;
    if (typeof p.exp !== "number" || p.exp * 1000 <= Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}
