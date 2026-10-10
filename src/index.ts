// Rift Builder Worker entry point.
//
// One Worker serves the whole playable:
//   /                      the game page (public/index.html) and its assets
//   /solfray-playable.json the Solfray manifest (also at /.json, /index.html.json)
//   /api/*                 maps and identity (src/api/maps.ts)
//   /auth/*                Google sign-in for the standalone site (src/auth/google.ts)
//   /ws/room/:id           standalone multiplayer rooms (src/room.ts)
//
// SOLFRAY TIE-IN, the short version. A Solfray playable is a static page that
// Solfray frames beside a thread. Solfray gives the page identity, the roster,
// a relay, and one shared room-state object through the SDK
// (public/js/solfray-playable.js). Solfray is NOT the game's database. This
// Worker is: it stores the maps players build, keyed on identities that are
// either Google accounts (standalone) or Solfray wallets proven by playable
// tokens (auth/solfray.ts). Each tie-in is marked "SOLFRAY TIE-IN" in the
// file where it lives.

import type { Env } from "./env";
import { error, preflight } from "./http";
import { handleApi } from "./api/maps";
import { googleCallback, googleLogin, logout } from "./auth/google";
import { identify } from "./auth/identity";
import { randomId } from "./auth/crypto";

export { RoomDO } from "./room";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ---- API ------------------------------------------------------------
      if (path.startsWith("/api/")) {
        if (req.method === "OPTIONS") return preflight();
        return await handleApi(req, env, path);
      }

      // ---- Google sign-in (standalone only) --------------------------------
      if (path === "/auth/google/login" && req.method === "GET") return await googleLogin(req, env);
      if (path === "/auth/google/callback" && req.method === "GET") return await googleCallback(req, env);
      if (path === "/auth/logout" && req.method === "POST") return logout(req);

      // ---- Standalone multiplayer rooms -------------------------------------
      const room = path.match(/^\/ws\/room\/([A-Za-z0-9_-]{1,64})$/);
      if (room) return await joinRoom(req, env, room[1]);

      // ---- Static assets ---------------------------------------------------
      return await serveAsset(req, env, path);
    } catch (e) {
      console.error("unhandled", e);
      return error("internal", 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Upgrade a WebSocket into the room's Durable Object, carrying the caller's
 *  identity in headers the client can never set (we overwrite them). */
async function joinRoom(req: Request, env: Env, roomId: string): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") return error("expected_websocket", 426);
  const { who } = await identify(req, env);
  const headers = new Headers(req.headers);
  // Guests are welcome in standalone rooms: a random id for this visit,
  // the same way Solfray seats a guest with a random anon key.
  const pk = who ? who.id : `guest:${randomId(8)}`;
  headers.set("X-Rb-Pk", pk);
  headers.set("X-Rb-Display", who ? who.display : `Guest-${pk.slice(6, 10)}`);
  headers.set("X-Rb-Anon", who && !who.anon ? "0" : "1");
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  return stub.fetch(new Request(req.url, { method: "GET", headers }));
}

/** Static files with the headers the Solfray guide asks for. */
async function serveAsset(req: Request, env: Env, path: string): Promise<Response> {
  // SOLFRAY TIE-IN: Solfray looks for the manifest at the page URL + ".json"
  // first, then at solfray-playable.json beside the page and at the origin
  // root (guide section 7). Our page is "/", so answer all three spellings.
  let assetPath = path;
  if (path === "/.json" || path === "/index.html.json") assetPath = "/solfray-playable.json";

  const assetReq = new Request(new URL(assetPath, req.url), req);
  let res = await env.ASSETS.fetch(assetReq);
  if (res.status === 404 && req.method === "GET") {
    // Any unknown path still loads the game (so /some-map-id can be shared),
    // unless it looks like a file.
    if (!/\.[a-z0-9]{1,5}$/i.test(path)) res = await env.ASSETS.fetch(new Request(new URL("/index.html", req.url), req));
  }
  if (res.status !== 200) return res;

  const out = new Response(res.body, res);
  const ct = out.headers.get("Content-Type") || "";
  if (ct.includes("text/html") || assetPath === "/solfray-playable.json") {
    // SOLFRAY TIE-IN (guide 7c): serve the page and the manifest uncached so
    // a redeploy reaches players on reload; hashed assets may cache freely.
    out.headers.set("Cache-Control", "no-cache");
  }
  if (ct.includes("text/html")) {
    // SOLFRAY TIE-IN (guide section 7, step 3): only Solfray (and uz.games,
    // the sister site on the same SDK) may frame this page, plus ourselves
    // for the standalone site. Anyone else embedding it gets a blank frame.
    out.headers.set(
      "Content-Security-Policy",
      "frame-ancestors 'self' https://solfray.com https://*.solfray.com https://uz.games https://*.uz.games"
    );
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (assetPath === "/solfray-playable.json") out.headers.set("Access-Control-Allow-Origin", "*");
  return out;
}
