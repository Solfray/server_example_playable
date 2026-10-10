// D1 access. The schema is created lazily with IF NOT EXISTS so a brand-new
// deploy works before anyone runs `wrangler d1 migrations apply`; the same
// statements live in migrations/0001_init.sql for people who prefer that.

import type { Env } from "./env";

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, display TEXT NOT NULL,
          created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS maps (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL, size_bytes INTEGER NOT NULL,
          is_public INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS maps_owner ON maps(owner_id, updated_at DESC)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS maps_public ON maps(is_public, updated_at DESC)`),
      ]);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export async function upsertUser(env: Env, id: string, kind: "google" | "solfray", display: string): Promise<void> {
  await ensureSchema(env);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, kind, display, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO UPDATE SET display = excluded.display, last_seen = excluded.last_seen`
  )
    .bind(id, kind, display, now)
    .run();
}
