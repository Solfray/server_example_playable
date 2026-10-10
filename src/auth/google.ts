// Google sign-in (OpenID Connect, authorization code flow) for the
// standalone page. This is the whole login system: no passwords, no email
// verification, no account table beyond `users`. Google is the identity
// provider; we keep only the stable `sub` and a display name.
//
// Routes (wired in src/index.ts):
//   GET  /auth/google/login      -> redirect to Google
//   GET  /auth/google/callback   -> verify, set session cookie, redirect home
//   POST /auth/logout            -> clear the cookie
//
// SOLFRAY TIE-IN: none of this runs for a player inside Solfray. There the
// page never shows a Google button; the Solfray host already authenticated
// the player and the playable token carries their identity (auth/solfray.ts).
// Google exists so the very same page works as a plain website too.

import type { Env } from "../env";
import { cookie, isHttps, parseCookies } from "../http";
import { randomId, splitJwt, verifyRs256 } from "./crypto";
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_TTL_S, openCookie, sealCookie, type SessionPayload } from "./session";
import { upsertUser } from "../db";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

interface OauthState {
  state: string;
  nonce: string;
  return_to: string;
  exp: number;
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
}

function redirectUri(req: Request): string {
  return `${new URL(req.url).origin}/auth/google/callback`;
}

/** Only ever send people back to a path on this site. */
function safeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.slice(0, 512);
}

export async function googleLogin(req: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) {
    return new Response("Google sign-in is not configured. See README.md (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET).", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const url = new URL(req.url);
  const st: OauthState = {
    state: randomId(16),
    nonce: randomId(16),
    return_to: safeReturnTo(url.searchParams.get("return_to")),
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: "openid profile",
    state: st.state,
    nonce: st.nonce,
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GOOGLE_AUTH}?${params}`,
      "Set-Cookie": cookie(OAUTH_COOKIE, await sealCookie(env.SESSION_SECRET!, st), 600, isHttps(req)),
    },
  });
}

export async function googleCallback(req: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) return new Response("not configured", { status: 503 });
  const url = new URL(req.url);
  const cookies = parseCookies(req);
  const st = await openCookie<OauthState>(env.SESSION_SECRET!, cookies[OAUTH_COOKIE]);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!st || !code || !state || state !== st.state) {
    return new Response("Sign-in state mismatch. Go back and try again.", { status: 400 });
  }

  // Exchange the code for tokens. The client secret proves to Google that the
  // redirect really ended up at our server, not at a look-alike.
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return new Response("Google token exchange failed.", { status: 502 });
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return new Response("No id_token from Google.", { status: 502 });

  const claims = await verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID, st.nonce);
  if (!claims) return new Response("Google id_token failed verification.", { status: 401 });

  const uid = `google:${claims.sub}`;
  const display = (claims.name || claims.given_name || "Player").toString().slice(0, 48);
  await upsertUser(env, uid, "google", display);

  const sess: SessionPayload = {
    uid,
    display,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  };
  const headers = new Headers({ Location: st.return_to });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sealCookie(env.SESSION_SECRET!, sess), SESSION_TTL_S, isHttps(req)));
  headers.append("Set-Cookie", cookie(OAUTH_COOKIE, "", 0, isHttps(req)));
  return new Response(null, { status: 302, headers });
}

export function logout(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": cookie(SESSION_COOKIE, "", 0, isHttps(req)) },
  });
}

// ---- id_token verification -------------------------------------------------

interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
  given_name?: string;
  picture?: string;
}

let googleKeys: { at: number; keys: Array<JsonWebKey & { kid?: string }> } | null = null;

async function getGoogleKeys(force: boolean): Promise<Array<JsonWebKey & { kid?: string }>> {
  if (!force && googleKeys && Date.now() - googleKeys.at < 3600_000) return googleKeys.keys;
  const r = await fetch(GOOGLE_JWKS, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  if (!r.ok) throw new Error("google_jwks_failed");
  const body = (await r.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  googleKeys = { at: Date.now(), keys: body.keys };
  return body.keys;
}

async function verifyGoogleIdToken(idToken: string, clientId: string, nonce: string): Promise<GoogleClaims | null> {
  const parts = splitJwt(idToken);
  if (!parts || parts.header?.alg !== "RS256" || typeof parts.header.kid !== "string") return null;
  let keys = await getGoogleKeys(false);
  let key = keys.find((k) => k.kid === parts.header.kid);
  if (!key) {
    keys = await getGoogleKeys(true);
    key = keys.find((k) => k.kid === parts.header.kid);
  }
  if (!key) return null;
  if (!(await verifyRs256(key, parts.signingInput, parts.signature))) return null;
  const c = parts.payload as GoogleClaims;
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return null;
  if (c.aud !== clientId) return null;
  if (typeof c.exp !== "number" || c.exp * 1000 <= Date.now()) return null;
  if (c.nonce !== nonce) return null;
  if (typeof c.sub !== "string" || !c.sub) return null;
  return c;
}
