// Maps: validation and the REST routes.
//
//   GET    /api/me                 who am I (and is Google sign-in configured)
//   GET    /api/maps?scope=public  public maps, newest first (no map data)
//   GET    /api/maps?scope=mine    my maps (signed in)
//   GET    /api/maps/:id           one map with its data (public, or mine)
//   POST   /api/maps               create (signed in, not a guest)
//   PUT    /api/maps/:id           update (owner only)
//   DELETE /api/maps/:id           delete (owner only)
//   POST   /api/maps/:id/play      bump the play counter (anyone)
//
// Ownership is the string maps.owner_id, which is always one of
// "google:<sub>" or "solfray:<pk>", produced only by auth/identity.ts. A
// request can never name an owner: the owner is whoever the verified identity
// says is calling.

import type { Env } from "../env";
import { error, json, readJson } from "../http";
import { identify, type Identity } from "../auth/identity";
import { ensureSchema, upsertUser } from "../db";
import { randomId } from "../auth/crypto";

// ---- the map format ---------------------------------------------------------
//
// {
//   "schema": 1,
//   "size":   [w, h, d],              4..64 cells on each axis
//   "spawn":  [x, y, z, yaw],         cell coordinates (floats allowed), radians
//   "blocks": [[x, y, z, type], ...]  one entry per solid cell, type below;
//             a fifth element `meta` (0..7) is allowed on stair blocks:
//             bits 0-1 the facing (0:+Z 1:+X 2:-Z 3:-X), bit 2 upside down
// }
//
// Block types (public/js/world.js draws them, public/js/player.js collides):
export const BLOCK = {
  PANEL: 1, // light panel: solid, rifts (portals) may be placed on it
  STEEL: 2, // dark plate: solid, rifts bounce off
  GOAL: 3, // exit pad: touching it finishes the map for that player
  HAZARD: 4, // acid: touching it sends the player back to spawn
  BUTTON: 5, // floor button: any player standing on it opens every DOOR
  DOOR: 6, // door block: solid while no button is pressed
  GLASS: 7, // glass: solid, see-through, not riftable
  STAIR: 8, // panel stairs: a walkable slope; a two-step run takes a rift
  STAIR_STEEL: 9, // plate stairs: same shape, rifts bounce off
} as const;

const STAIR_TYPES = new Set<number>([BLOCK.STAIR, BLOCK.STAIR_STEEL]);

export const MAP_LIMITS = {
  minSize: 4,
  maxSize: 64,
  maxBlocks: 20_000,
  maxBytes: 256 * 1024,
  nameMax: 48,
  descMax: 300,
};

export interface MapData {
  schema: 1;
  size: [number, number, number];
  spawn: [number, number, number, number];
  blocks: Array<[number, number, number, number] | [number, number, number, number, number]>;
}

export type MapCheck = { ok: true; data: MapData } | { ok: false; field: string };

/** Validate untrusted map JSON. Returns a clean copy with only known fields. */
export function validateMap(raw: unknown): MapCheck {
  const bad = (field: string): MapCheck => ({ ok: false, field });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("root");
  const m = raw as Record<string, unknown>;
  if (m.schema !== 1) return bad("schema");
  if (!Array.isArray(m.size) || m.size.length !== 3) return bad("size");
  const size = m.size.map(Number) as [number, number, number];
  for (const n of size) {
    if (!Number.isInteger(n) || n < MAP_LIMITS.minSize || n > MAP_LIMITS.maxSize) return bad("size");
  }
  if (!Array.isArray(m.spawn) || m.spawn.length !== 4) return bad("spawn");
  const spawn = m.spawn.map(Number) as [number, number, number, number];
  if (spawn.some((v) => !Number.isFinite(v))) return bad("spawn");
  if (spawn[0] < 0 || spawn[0] > size[0] || spawn[1] < 0 || spawn[1] > size[1] || spawn[2] < 0 || spawn[2] > size[2]) return bad("spawn");
  if (!Array.isArray(m.blocks) || m.blocks.length > MAP_LIMITS.maxBlocks) return bad("blocks");
  const seen = new Set<number>();
  const blocks: MapData["blocks"] = [];
  const types = new Set<number>(Object.values(BLOCK));
  for (const b of m.blocks) {
    if (!Array.isArray(b) || (b.length !== 4 && b.length !== 5)) return bad("blocks");
    const [x, y, z, t] = b.map(Number);
    const meta = b.length === 5 ? Number(b[4]) : 0;
    if (![x, y, z, t, meta].every(Number.isInteger)) return bad("blocks");
    if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) return bad("blocks");
    if (!types.has(t)) return bad("blocks");
    // Only stairs carry meta, and only 0..7 (the client packs it in 3 bits).
    if (meta < 0 || meta > 7 || (meta !== 0 && !STAIR_TYPES.has(t))) return bad("blocks");
    const key = (x * size[1] + y) * size[2] + z;
    if (seen.has(key)) continue; // duplicate cell: last one is dropped, first wins
    seen.add(key);
    blocks.push(meta ? [x, y, z, t, meta] : [x, y, z, t]);
  }
  return { ok: true, data: { schema: 1, size, spawn, blocks } };
}

function cleanText(v: unknown, max: number, required: boolean): string | null {
  if (v === undefined || v === null) return required ? null : "";
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (required && !t) return null;
  return t.length > max ? null : t;
}

// ---- routes -----------------------------------------------------------------

interface MapRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  data?: string;
  size_bytes: number;
  is_public: number;
  plays: number;
  created_at: number;
  updated_at: number;
  owner_display?: string;
}

function publicRow(r: MapRow, who: Identity | null) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    owner: r.owner_display || "someone",
    // The owner's kind is public (it is in the id prefix) but the id itself
    // is not returned: a Google `sub` is nobody's business, and a Solfray pk
    // is already visible to everyone in the room anyway.
    owner_kind: r.owner_id.split(":")[0],
    mine: Boolean(who && who.id === r.owner_id),
    is_public: Boolean(r.is_public),
    plays: r.plays,
    size_bytes: r.size_bytes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const LIST_SQL = `SELECT m.id, m.owner_id, m.name, m.description, m.size_bytes, m.is_public, m.plays,
                         m.created_at, m.updated_at, u.display AS owner_display
                  FROM maps m LEFT JOIN users u ON u.id = m.owner_id`;

export async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  await ensureSchema(env);
  const { who, error: idErr } = await identify(req, env);
  // A bad Bearer token is a hard failure: the client sent proof and it did
  // not check out, so do not quietly fall back to anonymous.
  if (idErr && idErr.startsWith("solfray_")) return error(idErr, 401);
  if (idErr === "csrf_origin") return error("csrf_origin", 403);

  if (path === "/api/me" && req.method === "GET") {
    return json({
      who: who ? { id: who.id, kind: who.kind, display: who.display, anon: who.anon } : null,
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET),
    });
  }

  if (path === "/api/maps" && req.method === "GET") {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") || "public";
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    if (scope === "mine") {
      if (!who) return error("unauthorized", 401);
      const rows = await env.DB.prepare(`${LIST_SQL} WHERE m.owner_id = ?1 ORDER BY m.updated_at DESC LIMIT ?2`)
        .bind(who.id, limit)
        .all<MapRow>();
      return json({ maps: rows.results.map((r) => publicRow(r, who)) });
    }
    const rows = await env.DB.prepare(`${LIST_SQL} WHERE m.is_public = 1 ORDER BY m.updated_at DESC LIMIT ?1`)
      .bind(limit)
      .all<MapRow>();
    return json({ maps: rows.results.map((r) => publicRow(r, who)) });
  }

  if (path === "/api/maps" && req.method === "POST") {
    if (!who) return error("unauthorized", 401, "Sign in to save maps.");
    if (who.anon) return error("guest_cannot_save", 403, "Guests can play but not save. Sign in to Solfray with a wallet, or with Google on the standalone site.");
    const body = await readJson<{ name?: unknown; description?: unknown; is_public?: unknown; data?: unknown }>(req, MAP_LIMITS.maxBytes + 4096);
    if (!body) return error("bad_request", 400);
    const name = cleanText(body.name, MAP_LIMITS.nameMax, true);
    const description = cleanText(body.description, MAP_LIMITS.descMax, false);
    if (name === null) return error("bad_name", 400);
    if (description === null) return error("bad_description", 400);
    const check = validateMap(body.data);
    if (!check.ok) return error("bad_map", 400, `field: ${check.field}`);
    const data = JSON.stringify(check.data);
    if (data.length > MAP_LIMITS.maxBytes) return error("map_too_large", 413);
    const now = Date.now();
    const id = randomId(9);
    // The owner row must exist (maps.owner_id references users.id). Solfray
    // identities are upserted at verification time; Google sessions only at
    // sign-in, so refresh here in case the users table was reset.
    await upsertUser(env, who.id, who.kind, who.display);
    await env.DB.prepare(
      `INSERT INTO maps (id, owner_id, name, description, data, size_bytes, is_public, plays, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`
    )
      .bind(id, who.id, name, description, data, data.length, body.is_public ? 1 : 0, now)
      .run();
    return json({ id }, 201);
  }

  const one = path.match(/^\/api\/maps\/([A-Za-z0-9_-]{6,32})(\/play)?$/);
  if (one) {
    const id = one[1];
    const row = await env.DB.prepare(`${LIST_SQL.replace("m.size_bytes", "m.data, m.size_bytes")} WHERE m.id = ?1`)
      .bind(id)
      .first<MapRow>();
    if (!row) return error("not_found", 404);
    const mine = Boolean(who && who.id === row.owner_id);

    if (one[2] === "/play" && req.method === "POST") {
      if (!row.is_public && !mine) return error("not_found", 404);
      await env.DB.prepare(`UPDATE maps SET plays = plays + 1 WHERE id = ?1`).bind(id).run();
      return json({ ok: true });
    }

    if (req.method === "GET") {
      // Private maps are visible to their owner only. A Solfray guest, or
      // anyone who merely knows the id, sees 404, not 403, so private ids
      // leak nothing.
      if (!row.is_public && !mine) return error("not_found", 404);
      return json({ ...publicRow(row, who), data: JSON.parse(row.data!) });
    }

    // Everything below mutates: owner only. `mine` is derived from the
    // verified identity and the row, never from the request.
    if (!who) return error("unauthorized", 401);
    if (!mine) return error("forbidden", 403, "Only the map's owner can change it.");

    if (req.method === "PUT") {
      const body = await readJson<{ name?: unknown; description?: unknown; is_public?: unknown; data?: unknown }>(req, MAP_LIMITS.maxBytes + 4096);
      if (!body) return error("bad_request", 400);
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (body.name !== undefined) {
        const name = cleanText(body.name, MAP_LIMITS.nameMax, true);
        if (name === null) return error("bad_name", 400);
        sets.push(`name = ?${binds.push(name)}`);
      }
      if (body.description !== undefined) {
        const d = cleanText(body.description, MAP_LIMITS.descMax, false);
        if (d === null) return error("bad_description", 400);
        sets.push(`description = ?${binds.push(d)}`);
      }
      if (body.is_public !== undefined) sets.push(`is_public = ?${binds.push(body.is_public ? 1 : 0)}`);
      if (body.data !== undefined) {
        const check = validateMap(body.data);
        if (!check.ok) return error("bad_map", 400, `field: ${check.field}`);
        const data = JSON.stringify(check.data);
        if (data.length > MAP_LIMITS.maxBytes) return error("map_too_large", 413);
        sets.push(`data = ?${binds.push(data)}`);
        sets.push(`size_bytes = ?${binds.push(data.length)}`);
      }
      if (!sets.length) return error("nothing_to_update", 400);
      sets.push(`updated_at = ?${binds.push(Date.now())}`);
      binds.push(id);
      await env.DB.prepare(`UPDATE maps SET ${sets.join(", ")} WHERE id = ?${binds.length}`)
        .bind(...binds)
        .run();
      return json({ ok: true });
    }

    if (req.method === "DELETE") {
      await env.DB.prepare(`DELETE FROM maps WHERE id = ?1`).bind(id).run();
      return json({ ok: true });
    }
  }

  return error("not_found", 404);
}
