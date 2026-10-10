// One function answers "who is making this request?" for every API route.
//
// Two identity providers, one shape:
//
//   Authorization: Bearer <solfray playable token>   -> { id: "solfray:<pk>", ... }
//   Cookie: rb_session=...  (Google sign-in)          -> { id: "google:<sub>", ... }
//   neither                                           -> null (anonymous)
//
// The Bearer path wins when both are present, because a page running inside
// Solfray IS a Solfray player, whatever cookies happen to exist.
//
// SOLFRAY TIE-IN: this is where a Solfray playable token becomes a first-class
// account on our server. Note what we do NOT do: we never create a session
// cookie from a Solfray token. Every API call from inside Solfray carries a
// fresh (<= 5 min) token, so there is nothing long-lived to steal and nothing
// to revoke. The client caches a token until shortly before `exp`
// (public/js/api.js) and asks the SDK for a new one after that.

import type { Env } from "../env";
import { parseCookies } from "../http";
import { makeJwksFetcher, verifySolfrayToken } from "./solfray";
import { SESSION_COOKIE, openCookie, type SessionPayload } from "./session";
import { upsertUser } from "../db";

export interface Identity {
  /** Namespaced, stable, used as maps.owner_id. */
  id: string;
  kind: "google" | "solfray";
  display: string;
  /** Solfray guests can play but not own maps. Google users are never anon. */
  anon: boolean;
  /** Solfray only: the thread instance the token was minted in. */
  instance?: string;
}

export type IdentityResult = { who: Identity | null; error?: string };

export async function identify(req: Request, env: Env): Promise<IdentityResult> {
  const auth = req.headers.get("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    const jwt = auth.replace(/^Bearer\s+/i, "").trim();
    const res = await verifySolfrayToken(jwt, {
      origin: new URL(req.url).origin,
      solfrayOrigin: env.SOLFRAY_ORIGIN,
      getJwks: makeJwksFetcher(env.SOLFRAY_ORIGIN),
    });
    if (!res.ok) return { who: null, error: `solfray_${res.error}` };
    const c = res.claims;
    const who: Identity = {
      id: `solfray:${c.sub}`,
      kind: "solfray",
      // The token does not carry a display name (the roster does, client
      // side). We label the account by a shortened key; the page shows the
      // Solfray display name it already has from sf.me.
      display: c.anon ? `guest-${c.sub.slice(0, 4)}` : `${c.sub.slice(0, 4)}…${c.sub.slice(-4)}`,
      anon: c.anon,
      instance: c.inst,
    };
    if (!who.anon) await upsertUser(env, who.id, "solfray", who.display);
    return { who };
  }

  // Standalone: the HMAC-signed Google session cookie.
  if (env.SESSION_SECRET) {
    const sess = await openCookie<SessionPayload>(env.SESSION_SECRET, parseCookies(req)[SESSION_COOKIE]);
    if (sess) {
      // CSRF guard for cookie-authenticated writes: the browser must say the
      // request came from our own origin. Bearer requests need no such guard
      // (the token is not ambient).
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.get("Origin");
        const site = req.headers.get("Sec-Fetch-Site");
        const self = new URL(req.url).origin;
        if (!((origin && origin === self) || site === "same-origin")) {
          return { who: null, error: "csrf_origin" };
        }
      }
      return { who: { id: sess.uid, kind: "google", display: sess.display, anon: false } };
    }
  }
  return { who: null };
}
