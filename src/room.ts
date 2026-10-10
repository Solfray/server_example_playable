// RoomDO: realtime relay for STANDALONE play (the page opened on its own,
// not inside Solfray). One Durable Object per room; the room id is the map id
// plus an optional suffix (?room=...).
//
// SOLFRAY TIE-IN: inside Solfray none of this runs. Solfray's own Durable
// Object relays poses, events, and the shared room state between everyone
// who launched the thread, and the page talks to it through the SDK
// (sf.pose, sf.event, sf.setState). This class exists so the same page works
// as a plain website, and its wire protocol deliberately mirrors the SDK
// surface so public/js/net.js can wrap either behind one interface:
//
//   client -> room                    room -> client
//   ----------------------------      -------------------------------------
//   hello {}                          ready {me, participants, host_seq, state, t}
//   pose  {d}                         pose  {from, d, t}        (to everyone else)
//   event {d, to?}                    event {from, d, t, id}   (everyone else, or one)
//   relay {d, to?}                    relay {from, d}
//   state {data}                      state {from, seq, data}  (everyone)
//   ping  {c}                         pong  {c, t}             (clock sync)
//                                     join  {participant}
//                                     leave {pk, host_seq}
//                                     err   {code}
//
// Authority follows the Solfray rule: the participant with the lowest
// join_seq is the host peer, and it moves only when that player leaves.
// `from` is stamped by the room, never trusted from the sender, exactly as
// Solfray's relay does.
//
// Limits (close to Solfray.LIMITS): 50 participants, pose <= 1 KB at 20/s,
// event/relay <= 4 KB at 30/s, state <= 32 KB at 4/s.

import { DurableObject } from "cloudflare:workers";

interface Attachment {
  pk: string;
  display: string;
  anon: boolean;
  join_seq: number;
}

interface RoomState {
  seq: number;
  data: unknown;
}

const MAX_PLAYERS = 50;
const LIMITS = { pose: 1024, event: 4096, state: 32 * 1024 };

export class RoomDO extends DurableObject {
  private buckets = new Map<WebSocket, { pose: number; event: number; state: number; at: number }>();

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pk = req.headers.get("X-Rb-Pk") || "";
    const display = req.headers.get("X-Rb-Display") || "Player";
    const anon = req.headers.get("X-Rb-Anon") === "1";
    if (!pk) return new Response("no identity", { status: 400 });

    const live = this.roster();
    // One entry per account: a second tab replaces the first, as on Solfray.
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && a.pk === pk) {
        try {
          ws.close(1000, "replaced");
        } catch {}
      }
    }
    if (live.filter((p) => p.pk !== pk).length >= MAX_PLAYERS) return new Response("room full", { status: 429 });

    // join_seq: monotonic while anyone is in the room, reset when it empties.
    let next = ((await this.ctx.storage.get<number>("next_seq")) ?? 0) + 1;
    if (live.length === 0) next = 1;
    await this.ctx.storage.put("next_seq", next);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const me: Attachment = { pk, display, anon, join_seq: next };
    server.serializeAttachment(me);
    // Hibernation API: the DO can be evicted between messages and wake with
    // its sockets intact; the attachment is how we remember who is who.
    this.ctx.acceptWebSocket(server);

    const state = (await this.ctx.storage.get<RoomState>("state")) ?? null;
    const participants = this.roster();
    this.send(server, {
      t: "ready",
      me,
      participants,
      host_seq: hostSeq(participants),
      state,
      t_now: Date.now(),
    });
    this.broadcast({ t: "join", participant: me }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me) return;
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    switch (m?.t) {
      case "ping":
        this.send(ws, { t: "pong", c: m.c, t_now: now });
        return;
      case "pose": {
        if (raw.length > LIMITS.pose) return this.send(ws, { t: "err", code: "too_big" });
        if (!this.allow(ws, "pose")) return;
        this.broadcast({ t: "pose", from: me.pk, d: m.d, t_now: now }, ws);
        return;
      }
      case "event":
      case "relay": {
        if (raw.length > LIMITS.event) return this.send(ws, { t: "err", code: "too_big" });
        if (!this.allow(ws, "event")) return this.send(ws, { t: "err", code: "rate_limited" });
        const out = m.t === "event" ? { t: "event", from: me.pk, d: m.d, t_now: now, id: crypto.randomUUID() } : { t: "relay", from: me.pk, d: m.d };
        if (typeof m.to === "string") {
          for (const other of this.ctx.getWebSockets()) {
            const a = other.deserializeAttachment() as Attachment | null;
            if (a && a.pk === m.to) this.send(other, out);
          }
        } else {
          this.broadcast(out, ws);
        }
        return;
      }
      case "state": {
        // Last write wins, like Solfray's room state. Any participant may
        // write; the page's convention is that only the host does.
        if (raw.length > LIMITS.state) return this.send(ws, { t: "err", code: "too_big" });
        if (!this.allow(ws, "state")) return this.send(ws, { t: "err", code: "rate_limited" });
        const prev = (await this.ctx.storage.get<RoomState>("state")) ?? { seq: 0, data: null };
        const next: RoomState = { seq: prev.seq + 1, data: m.data ?? null };
        await this.ctx.storage.put("state", next);
        this.broadcast({ t: "state", from: me.pk, seq: next.seq, data: next.data }, null);
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  private async gone(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    this.buckets.delete(ws);
    try {
      ws.close(1000, "bye");
    } catch {}
    const left = this.roster().filter((p) => p !== me && p.pk !== me?.pk);
    if (me) this.broadcast({ t: "leave", pk: me.pk, host_seq: hostSeq(left) }, ws);
    if (left.length === 0) await this.ctx.storage.put("next_seq", 0);
  }

  /** Live participants from the open sockets, one per pk, lowest seq first. */
  private roster(): Attachment[] {
    const byPk = new Map<string, Attachment>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      const prev = byPk.get(a.pk);
      if (!prev || a.join_seq < prev.join_seq) byPk.set(a.pk, a);
    }
    return [...byPk.values()].sort((x, y) => x.join_seq - y.join_seq);
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private broadcast(msg: unknown, except: WebSocket | null): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(s);
      } catch {}
    }
  }

  /** Token bucket per socket and kind. Refill rates match the limits in the
   *  header comment. Memory only: after hibernation everyone starts full. */
  private allow(ws: WebSocket, kind: "pose" | "event" | "state"): boolean {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b) {
      b = { pose: 40, event: 60, state: 8, at: now };
      this.buckets.set(ws, b);
    }
    const dt = (now - b.at) / 1000;
    b.at = now;
    b.pose = Math.min(40, b.pose + dt * 20);
    b.event = Math.min(60, b.event + dt * 30);
    b.state = Math.min(8, b.state + dt * 4);
    if (b[kind] < 1) return false;
    b[kind] -= 1;
    return true;
  }
}

function hostSeq(roster: Attachment[]): number | null {
  return roster.length ? roster[0].join_seq : null;
}
