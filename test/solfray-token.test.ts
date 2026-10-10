// The security claim of this example, as tests:
//
//   "Nobody can save or edit as a Solfray user just by claiming their key."
//
// We play solfray.com: generate an Ed25519 key, publish it as a JWK set, and
// sign tokens the way core/src/playable-token.ts does. Then we play the
// attacker: same claims, wrong key; right key, wrong audience; expired;
// alg swapped; and a token that merely *says* sub = victim.

import { describe, expect, it } from "vitest";
import { verifySolfrayToken, type Jwks } from "../src/auth/solfray";
import { b64url, utf8 } from "../src/auth/crypto";

const ORIGIN = "https://rift-builder.example.workers.dev";
const SOLFRAY = "https://solfray.com";
const VICTIM = "7kS9mQ2xRvB4yN6pL8wA3cD5eF1gH9jK0zXcVbNmQ2mR";

async function keypair(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const jwk = { kty: "OKP", crv: "Ed25519", x: pub.x!, kid, use: "sig", alg: "EdDSA" } as JsonWebKey & { kid: string };
  return { priv: kp.privateKey, jwk };
}

async function sign(priv: CryptoKey, header: object, payload: object): Promise<string> {
  const h = b64url(utf8(JSON.stringify(header)));
  const p = b64url(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, utf8(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

function claims(over: Partial<Record<string, unknown>> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return { iss: "solfray.com", aud: ORIGIN, sub: VICTIM, anon: false, inst: "7kS9…:4812", seq: 3, iat, exp: iat + 300, ...over };
}

describe("Solfray playable token verification", async () => {
  const solfray = await keypair("87d341c5");
  const attacker = await keypair("87d341c5"); // even reuses Solfray's kid
  const jwks: Jwks = { keys: [solfray.jwk] };
  const opts = { origin: ORIGIN, solfrayOrigin: SOLFRAY, getJwks: async () => jwks };
  const header = { alg: "EdDSA", typ: "JWT", kid: "87d341c5" };

  it("accepts a genuine token for this origin", async () => {
    const jwt = await sign(solfray.priv, header, claims());
    const r = await verifySolfrayToken(jwt, opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.sub).toBe(VICTIM);
      expect(r.claims.anon).toBe(false);
    }
  });

  it("rejects a token that claims the victim's key but was signed by someone else", async () => {
    // This is "claiming to own their PK": the payload is a perfect copy of a
    // real token's claims. Only the signature differs, and that is enough.
    const jwt = await sign(attacker.priv, header, claims());
    const r = await verifySolfrayToken(jwt, opts);
    expect(r).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects a genuine token minted for a different game's origin", async () => {
    const jwt = await sign(solfray.priv, header, claims({ aud: "https://other-game.example" }));
    const r = await verifySolfrayToken(jwt, opts);
    expect(r).toEqual({ ok: false, error: "bad_audience" });
  });

  it("rejects an expired token", async () => {
    const iat = Math.floor(Date.now() / 1000) - 600;
    const jwt = await sign(solfray.priv, header, claims({ iat, exp: iat + 300 }));
    const r = await verifySolfrayToken(jwt, opts);
    expect(r).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const jwt = await sign(solfray.priv, header, claims({ sub: "someone-else" }));
    const [h, , s] = jwt.split(".");
    const forged = `${h}.${b64url(utf8(JSON.stringify(claims())))}.${s}`;
    const r = await verifySolfrayToken(forged, opts);
    expect(r).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects alg: none and any non-EdDSA algorithm", async () => {
    const h = b64url(utf8(JSON.stringify({ alg: "none", typ: "JWT" })));
    const p = b64url(utf8(JSON.stringify(claims())));
    expect(await verifySolfrayToken(`${h}.${p}.`, opts)).toEqual({ ok: false, error: "bad_alg" });
    const hs = await sign(solfray.priv, { alg: "HS256", typ: "JWT", kid: "87d341c5" }, claims());
    expect(await verifySolfrayToken(hs, opts)).toEqual({ ok: false, error: "bad_alg" });
  });

  it("rejects an unknown issuer and a guest-shaped token is still accepted but marked anon", async () => {
    const bad = await sign(solfray.priv, header, claims({ iss: "evil.example" }));
    expect(await verifySolfrayToken(bad, opts)).toEqual({ ok: false, error: "bad_issuer" });
    const guest = await sign(solfray.priv, header, claims({ sub: "anon-9f1a", anon: true }));
    const r = await verifySolfrayToken(guest, opts);
    expect(r.ok && r.claims.anon).toBe(true);
  });

  it("refetches the key set once for an unknown kid, then gives up", async () => {
    let calls = 0;
    const rotated = await keypair("ffffffff");
    const jwt = await sign(rotated.priv, { ...header, kid: "ffffffff" }, claims());
    // First: the old set only; after a forced refetch the new key appears.
    const r1 = await verifySolfrayToken(jwt, {
      ...opts,
      getJwks: async (force) => {
        calls++;
        return force ? { keys: [solfray.jwk, rotated.jwk] } : jwks;
      },
    });
    expect(r1.ok).toBe(true);
    expect(calls).toBe(2);
    // Attacker's kid never appears anywhere: unknown_key, two fetches, stop.
    const r2 = await verifySolfrayToken(await sign(attacker.priv, { ...header, kid: "deadbeef" }, claims()), opts);
    expect(r2).toEqual({ ok: false, error: "unknown_key" });
  });

  it("never reads identity from anywhere but the verified payload", async () => {
    // Garbage in every shape: no token, wrong segments, oversized.
    expect(await verifySolfrayToken("", opts)).toEqual({ ok: false, error: "bad_token" });
    expect(await verifySolfrayToken("a.b", opts)).toEqual({ ok: false, error: "bad_token" });
    expect(await verifySolfrayToken("x".repeat(3000), opts)).toEqual({ ok: false, error: "bad_token" });
  });
});
