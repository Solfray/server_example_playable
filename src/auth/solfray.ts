// Solfray playable tokens: how a Solfray user proves who they are to THIS
// server without ever logging in here.
//
// SOLFRAY TIE-IN (playables guide section 7a; spec docs/specs/playables.md 3.4)
//
// Inside Solfray, our page is an iframe. Solfray already knows who the player
// is (their wallet signed in to solfray.com) and which thread they launched
// the game from. Our page asks the SDK for proof:
//
//     const jwt = await sf.token();            // public/js/api.js does this
//     fetch("/api/maps", { headers: { Authorization: "Bearer " + jwt } })
//
// The SDK forwards `{t:"token"}` to the Solfray host page over the
// MessageChannel bridge. The host calls POST solfray.com/api/playable/token
// with the player's real session cookie. solfray.com checks that this wallet
// is on the roster of this thread RIGHT NOW and signs a JWT with its site
// Ed25519 key. The JWT comes back down the bridge to our page, and our page
// attaches it to API calls. Claims:
//
//     iss   "solfray.com"
//     aud   our origin, e.g. "https://rift-builder.example.workers.dev"
//     sub   the player's wallet public key (base58), or a guest id if anon
//     anon  true for a guest
//     inst  "<server_pk>:<root_id>", the thread the game was launched in
//     seq   the player's join_seq in that instance
//     iat, exp   five minutes
//
// WHY NOBODY CAN STEAL A SOLFRAY USER'S MAPS BY "CLAIMING" THEIR PUBLIC KEY
//
// The ONLY place this server reads a Solfray identity is `claims.sub` below,
// and `claims` only exists after the Ed25519 signature has verified against
// the public key solfray.com publishes at /api/playable/keys. Nothing in the
// request body, query string, or any other header is ever used as an
// identity. To forge a token for wallet X an attacker would need
// solfray.com's private signing seed, which never leaves solfray.com's
// Worker secrets. Further:
//
//   * `aud` must equal OUR origin, so a token minted for some other game's
//     origin (which that game's server legitimately sees) is useless here.
//   * `exp` is five minutes out, so a leaked token is a short-lived problem.
//   * `iss` must be the configured Solfray origin's host.
//   * The JWK set is fetched over HTTPS from solfray.com and cached briefly;
//     a `kid` we do not know triggers a refetch (key rotation), but a key
//     that is not in solfray.com's set is never trusted.
//   * Guests (anon: true) can play but cannot own maps (api/maps.ts): their
//     id is random and dies with the visit, so a map saved under it could
//     never be reclaimed anyway.
//
// A token proves "this wallet is in this Solfray thread right now". We turn
// that into the identity "solfray:<pk>" (auth/identity.ts) and the map table
// keys ownership on that string. Verification is offline: no call to
// solfray.com per request, only the cached JWK set.
//
// test/solfray-token.test.ts exercises every rejection path, including the
// attacker who signs a token for someone else's key with their own key.

import { splitJwt, verifyEd25519 } from "./crypto";

export interface SolfrayClaims {
  iss: string;
  aud: string;
  sub: string;
  anon: boolean;
  inst: string;
  seq: number;
  iat: number;
  exp: number;
}

export interface Jwks {
  keys: Array<JsonWebKey & { kid?: string }>;
}

export interface VerifyOptions {
  /** This Worker's origin, which must equal the token's `aud`. */
  origin: string;
  /** The Solfray origin, whose host must equal the token's `iss`. */
  solfrayOrigin: string;
  /** Returns the JWK set; `force` bypasses the cache (unknown kid). */
  getJwks: (force: boolean) => Promise<Jwks>;
  nowMs?: number;
}

export type VerifyResult = { ok: true; claims: SolfrayClaims } | { ok: false; error: string };

/** Verify a Solfray playable token offline. Pure: all I/O is injected. */
export async function verifySolfrayToken(jwt: string, opts: VerifyOptions): Promise<VerifyResult> {
  if (typeof jwt !== "string" || jwt.length > 2048) return { ok: false, error: "bad_token" };
  const parts = splitJwt(jwt);
  if (!parts) return { ok: false, error: "bad_token" };
  const { header, payload, signingInput, signature } = parts;

  // Algorithm pinning: Solfray signs with EdDSA only. Refusing anything else
  // closes the classic "alg: none" and key-confusion attacks before any key
  // is even looked up.
  if (!header || header.alg !== "EdDSA") return { ok: false, error: "bad_alg" };
  const kid = typeof header.kid === "string" ? header.kid : null;

  // Find the signing key by kid. Unknown kid: refetch once (rotation).
  let jwks: Jwks;
  try {
    jwks = await opts.getJwks(false);
  } catch {
    return { ok: false, error: "keys_unavailable" };
  }
  let key = pickKey(jwks, kid);
  if (!key) {
    try {
      jwks = await opts.getJwks(true);
    } catch {
      return { ok: false, error: "keys_unavailable" };
    }
    key = pickKey(jwks, kid);
  }
  if (!key) return { ok: false, error: "unknown_key" };

  if (!(await verifyEd25519(key, signingInput, signature))) return { ok: false, error: "bad_signature" };

  // Only now do we look at the claims: they are authentic, but are they for us?
  const c = payload as Partial<SolfrayClaims>;
  if (
    typeof c.iss !== "string" ||
    typeof c.aud !== "string" ||
    typeof c.sub !== "string" ||
    typeof c.anon !== "boolean" ||
    typeof c.inst !== "string" ||
    typeof c.seq !== "number" ||
    typeof c.iat !== "number" ||
    typeof c.exp !== "number"
  ) {
    return { ok: false, error: "bad_claims" };
  }
  const now = opts.nowMs ?? Date.now();
  if (c.exp * 1000 <= now) return { ok: false, error: "expired" };
  if (c.iat * 1000 > now + 60_000) return { ok: false, error: "not_yet_valid" };

  const expectedIss = new URL(opts.solfrayOrigin).host;
  if (c.iss !== expectedIss) return { ok: false, error: "bad_issuer" };

  // The audience check is what stops a token minted for a different game's
  // origin from being replayed here.
  if (c.aud !== opts.origin) return { ok: false, error: "bad_audience" };

  if (!c.sub || c.sub.length > 128) return { ok: false, error: "bad_claims" };
  return { ok: true, claims: c as SolfrayClaims };
}

function pickKey(jwks: Jwks, kid: string | null): (JsonWebKey & { kid?: string }) | null {
  if (!jwks || !Array.isArray(jwks.keys)) return null;
  if (kid) return jwks.keys.find((k) => k.kid === kid && k.kty === "OKP") ?? null;
  // No kid in the header: accept only when the set has exactly one key, so
  // there is no ambiguity about which key must verify.
  const okp = jwks.keys.filter((k) => k.kty === "OKP");
  return okp.length === 1 ? okp[0] : null;
}

// ---- JWK set fetching, cached per isolate ---------------------------------

let cached: { at: number; jwks: Jwks } | null = null;
const JWKS_TTL_MS = 5 * 60_000; // Solfray serves the set with max-age=300

/** Fetch solfray.com's playable key set. The documented path is
 *  /api/playable/keys (the same document is meant to appear at
 *  /.well-known/solfray-playable-keys.json). */
export function makeJwksFetcher(solfrayOrigin: string): (force: boolean) => Promise<Jwks> {
  return async (force: boolean) => {
    const now = Date.now();
    if (!force && cached && now - cached.at < JWKS_TTL_MS) return cached.jwks;
    const r = await fetch(`${solfrayOrigin}/api/playable/keys`, {
      headers: { Accept: "application/json" },
      // Let Cloudflare's cache absorb the fetch across isolates too.
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (!r.ok) {
      if (cached) return cached.jwks;
      throw new Error(`jwks_fetch_failed:${r.status}`);
    }
    const jwks = (await r.json()) as Jwks;
    cached = { at: now, jwks };
    return jwks;
  };
}
