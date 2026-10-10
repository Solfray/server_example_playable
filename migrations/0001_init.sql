-- Rift Builder schema. The Worker also runs these statements with
-- IF NOT EXISTS on first use (src/db.ts), so a fresh deploy works before
-- anyone runs `wrangler d1 migrations apply`.

-- One row per identity that has ever saved something.
-- id is namespaced so the two identity providers can never collide:
--   "google:<sub>"      a Google account (standalone sign-in)
--   "solfray:<pk>"      a Solfray wallet key, proven by a playable token
-- Never a bare public key: a bare key is exactly what an attacker would
-- type into a request body, and nothing in this schema trusts one.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,            -- "google" | "solfray"
  display    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Player-made maps. `data` is the map JSON (validated in src/api/maps.ts).
CREATE TABLE IF NOT EXISTS maps (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  is_public   INTEGER NOT NULL DEFAULT 0,
  plays       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS maps_owner  ON maps(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS maps_public ON maps(is_public, updated_at DESC);
