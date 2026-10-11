# Rift Builder

A first-person puzzle builder for 1 to 50 players, and an open-source example of a
**server-backed [Solfray](https://solfray.com) playable** running on one Cloudflare Worker.

Place two linked rifts on light panels, walk into one and come out of the other with your
momentum intact, reach the exit pad. Build your own maps block by block in the browser and
save them to the server; play them with friends inside Solfray or on the standalone site.
The controls are the ones every block-builder player already knows.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Solfray/server_example_playable)

> The button reads `wrangler.jsonc`, provisions the D1 database and the Durable Object, and
> asks for the secrets listed below.

---

## What it demonstrates

A Solfray playable is a static page that Solfray frames beside a thread. Solfray gives it
identity, the roster, a realtime relay, and one shared room-state object through the SDK.
Solfray is **not** the game's database. This repo is the other half: a server that stores
what players make, keyed on identities that are either

* **Solfray wallets**, proven by *playable tokens* (guide section 7a), or
* **Google accounts**, for people who open the page as a plain website.

Nobody writes a password form. Nobody can save or edit as a Solfray user just by typing
that user's public key (see [Security](#security)).

Every place the code touches the Solfray SDK or spec is marked `SOLFRAY TIE-IN` in a
comment. Grep for it.

| Tie-in | Where | What it does |
|---|---|---|
| `Solfray.connect({ version })` | `public/js/app.js` | Detects the Solfray host, resolves `hosted: false` in a bare tab |
| `sf.token()` → `Authorization: Bearer` | `public/js/api.js` | Attaches a 5-minute Solfray-signed JWT to every API call |
| Token verification | `src/auth/solfray.ts` | Ed25519 check against `https://solfray.com/api/playable/keys`, `aud` must be this origin |
| `sf.me`, `sf.participants`, `sf.isHost` | `public/js/net.js` (`SolfrayNet`) | Roster, colours (`Solfray.colorOf`), host election |
| `sf.pose` / `sf.poseOf` / `sf.event` | `public/js/app.js`, `avatars.js`, `rifts.js` | "You own your stuff": my avatar now, others interpolated, rifts as fire-and-tell events |
| `sf.setState` / `sf.state` | `public/js/app.js` (`writeState`, `onState`) | The host records the chosen map and who finished; late joiners follow |
| `sf.result(text)` | `public/js/app.js` (`resultText`) | The Wordle-style result string; "Post final score" in Solfray's chrome |
| `solfray:inputreset` | `public/js/app.js` | Held keys cleared on blur / pointer-lock loss |
| `/solfray-playable.json` | `public/`, `src/index.ts` | The manifest (name, players 1–50, version), served at every path Solfray tries |
| `frame-ancestors` | `src/index.ts` | Only solfray.com (and uz.games) may frame the page, plus the page itself |
| `Solfray.mock({ players })` | `?mock=2` | A fake hosted room for local development |
| `skins` / `p.skin` (guide 6b) | `public/js/model.js`, `avatars.js` | **Backburner.** The character already wraps a standard 64x64 skin image; declaring a `skin` slot in the manifest is all that is left |
| `p.nfts` (guide 6c) | `public/js/model.js` (comment) | **Backburner.** NFT-driven skins would go through the same `skins.approved` list |

When the page is **not** inside Solfray, `public/js/net.js` (`RoomNet`) talks to our own
Durable Object (`src/room.ts`) over a WebSocket with the same semantics, so the game code
never knows which relay it is on.

---

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars     # set SESSION_SECRET; Google is optional
npm run dev                        # http://localhost:8787
```

* `http://localhost:8787/?map=starter` plays the built-in map in a standalone room.
  Open it in two tabs to see two players.
* `http://localhost:8787/?map=starter&mock=2` fakes a Solfray room with a bot
  (the SDK's `Solfray.mock`; no token is minted in mock mode, so saving uses Google).
* `npm test` runs the token-verification and map-validation tests on Node.
* `npm run typecheck` typechecks the Worker.

Saving on the standalone site needs Google sign-in (below). Playing never needs an account.

### Controls

**Playing** (survival-style): `WASD` move, `Space` jump, `Shift` sneak (slower, never off an
edge), `Ctrl` sprint, mouse look. Left click fires the blue rift, right click the orange
one, `X` clears your rifts, `R` restarts, `B` enters build mode on your own maps, `M` opens
the map browser.

**Building** (creative-style): double-tap `Space` to fly (`Space` up, `Shift` down, `Ctrl`
fast). Right click places the selected block against the face you look at, left click
breaks, middle click picks the block you look at. `1`–`9` and the mouse wheel choose from
the hotbar, which holds every block type (no inventory screen); `0` is the spawn tool
(right click a block to spawn on top of it). Reach is five blocks.

### Blocks

| # | Block | Notes |
|---|---|---|
| 1 | Panel | light, solid, takes rifts |
| 2 | Plate | dark, solid, rifts bounce off |
| 3 | Glass | see-through, solid |
| 4 | Panel stairs | a slope you walk up (0.6 step-up); a run of two matching stairs takes a rift on the slope |
| 5 | Plate stairs | same shape, no rifts |
| 6 | Exit | touch it to finish |
| 7 | Acid | touch it and you respawn |
| 8 | Button | any player standing on it opens every door |
| 9 | Door | solid until a button is held |

Stairs face the way you look when you place them (high step away from you); placed on the
underside of a block, or on the upper half of a side face, they hang upside down, like
stair blocks in any voxel game. A stair cell stores its facing and flip in a `meta` value
(`[x, y, z, type, meta]` in the map JSON; see `src/api/maps.ts`).

**Rifts on slopes.** The rift's long axis runs along the climb and its normal points up
and out of the slope, so walking up the run carries you through, and the matching exit
preserves that momentum. Upside-down stairs do not take rifts.

### Characters, gun, textures

Every player is the familiar six-box figure (`public/js/model.js`), with its faces laid out
on a 64x64 image the standard way, so a ready-made skin in that layout drops in through
`Character.setSkin(image)`. Until textures are wired up, a flat skin in the player's
Solfray colour is painted through the same UVs. The portal gun is a handful of boxes with
a core that glows in the colour of the last rift fired. Block materials carry a `texture`
slot in `BLOCK_INFO` for the same reason: textures are a follow-up, not a redesign.

---

## Deploy your own

1. **Secrets.** Two, or three if you want Google sign-in:

   ```bash
   npx wrangler secret put SESSION_SECRET          # openssl rand -hex 32
   npx wrangler secret put GOOGLE_CLIENT_SECRET    # optional
   ```

   and set `GOOGLE_CLIENT_ID` in `wrangler.jsonc` `vars` (it is public).

2. **Deploy.** `npm run deploy`. Wrangler provisions the D1 database and the Durable
   Object on first deploy (no `database_id` is needed; if your Wrangler refuses, run
   `npx wrangler d1 create rift-builder` and paste the id into `wrangler.jsonc`).
   The schema is created on first request; `npm run migrate` applies the same SQL from
   `migrations/` if you prefer explicit migrations.

3. **Google sign-in (optional).** In Google Cloud Console create an OAuth 2.0 client of
   type *Web application* with these authorised redirect URIs:

   ```
   https://<your-worker-host>/auth/google/callback
   http://localhost:8787/auth/google/callback
   ```

   Without it the standalone site still works for playing and for Solfray users; the
   Maps panel says so.

4. **Publish on Solfray.** Post your Worker's URL in a Solfray channel and tick
   *this link is a playable*. Solfray fetches `/solfray-playable.json`, validates it, and
   every thread on that URL is a session. Bump `version` in the manifest **and** in
   `public/js/app.js` on each deploy (guide 7c).

Everything is free-tier friendly: one Worker, one D1 database, Durable Objects for rooms
(Durable Objects need the Workers Paid plan at the time of writing).

---

## How identity works

```
            inside Solfray                              standalone site
   ┌──────────────────────────────┐             ┌──────────────────────────────┐
   │ solfray.com (host page)      │             │ accounts.google.com          │
   │  session cookie, roster      │             │  OpenID Connect code flow    │
   └──────────┬───────────────────┘             └──────────┬───────────────────┘
              │ POST /api/playable/token                    │ id_token (RS256)
              │ signs EdDSA JWT {sub: pk, aud: our origin}  │ verified against Google JWKS
              ▼                                             ▼
   ┌──────────────────────────────┐             ┌──────────────────────────────┐
   │ our page (iframe)            │             │ our Worker /auth/google/*    │
   │  sf.token() → Bearer header  │             │  sets HMAC cookie rb_session │
   └──────────┬───────────────────┘             └──────────┬───────────────────┘
              ▼                                             ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ src/auth/identity.ts  →  { id: "solfray:<pk>" }  or  { id: "google:<sub>" } │
   │ maps.owner_id is always one of these two shapes, never request input       │
   └──────────────────────────────────────────────────────────────────────────┘
```

* Inside Solfray the page never has a cookie for our site (the session cookie is
  `SameSite=Lax` and Solfray's frame is cross-site), and does not need one: each API call
  carries a fresh token. Nothing long-lived exists to steal.
* On the standalone site the Bearer path is simply absent and the cookie does the work.
  Cookie-authenticated writes additionally require a same-origin `Origin` header
  (CSRF guard); the API's `Access-Control-Allow-Origin: *` is safe because credentials are
  never allowed cross-origin.
* Solfray **guests** (`anon: true`) can play everything and cannot save: their id dies
  with the visit, so a map saved under it could never be reclaimed.
* The two identity kinds are separate accounts on purpose. Linking them is a feature a
  real product might add; it is deliberately out of scope here.

## Security

The claim: **nobody can steal maps created by a Solfray user just by claiming to own
their public key.** How it holds, in `src/auth/solfray.ts`:

1. The only place a Solfray identity enters the server is `claims.sub` of a JWT whose
   Ed25519 signature has verified against the key set solfray.com publishes. Nothing in a
   request body, query string, or custom header is ever read as an identity.
2. `alg` is pinned to `EdDSA`; `alg: none` and HMAC key-confusion are refused before any
   key lookup.
3. `aud` must equal **our** origin. A token minted for another game (which that game's
   server legitimately receives) is useless here.
4. `iss` must be `solfray.com`; `exp` is five minutes; an unknown `kid` triggers one
   refetch of the key set (rotation) and then fails closed.
5. Ownership checks compare the verified identity against `maps.owner_id`; a private map
   returns 404 to anyone else, so ids leak nothing.

`test/solfray-token.test.ts` plays solfray.com (generates a key, publishes it, signs real
tokens) and then plays the attacker: same claims with the attacker's key, right key and
wrong audience, expired, edited payload, `alg: none`, unknown issuer. All rejected.

Map JSON is validated on every write (`src/api/maps.ts`): grid bounds, block types,
block count, byte size; unknown fields are stripped.

## Why this is not a clone of anyone's game

The idea of two linked portals in a first-person puzzle is a mechanic, and mechanics are
not protected. Everything else is our own: the name (rifts), the look, the block set,
the maps players make, no characters, no voice lines, no logos, no level recreations.
Keep it that way in forks.

## Layout

```
wrangler.jsonc            one Worker: assets + API + Durable Object + D1
src/index.ts              routing, asset headers (frame-ancestors, no-cache)
src/auth/solfray.ts       playable-token verification        <- the security story
src/auth/google.ts        Google OpenID Connect
src/auth/session.ts       HMAC session cookie
src/auth/identity.ts      Bearer-or-cookie → one Identity
src/api/maps.ts           map validation + REST
src/room.ts               RoomDO: standalone realtime relay (SDK-shaped protocol)
public/index.html         loads the Solfray SDK and Three.js
public/solfray-playable.json
public/js/app.js          boot, map choice, room state, result string, HUD
public/js/net.js          SolfrayNet | RoomNet behind one interface
public/js/api.js          fetch + playable token caching
public/js/world.js        voxel map, instanced meshes, starter map
public/js/player.js       first-person controller + grid collision
public/js/rifts.js        rift placement, render-to-texture views, teleport
public/js/avatars.js      remote players from interpolated poses
public/js/model.js        blocky character (64x64 skin UVs), portal gun, held block
public/js/editor.js       build mode: creative controls and the hotbar
test/                     vitest (Node): tokens, map validation
```

## Limits worth knowing

* 50 players per room (manifest `players.max`, `RoomDO` cap). Inside Solfray the relay's
  own budgets apply (Solfray.LIMITS); poses stream at 15 Hz per player either way.
* Maps: up to 64³ cells, 20,000 blocks, 256 KB JSON. Nine block types; stairs carry a
  3-bit orientation.
* The render-through view is drawn for **your own** rift pair only (two extra renders per
  frame); other players' rifts show a swirl. Doors open from the poses every page sees,
  so they need no host.

## License

MIT. See `LICENSE`.
