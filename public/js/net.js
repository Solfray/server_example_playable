// net.js: one interface for "the other players", two implementations.
//
//   SolfrayNet  wraps the Solfray SDK session when the page runs inside
//               Solfray (or Solfray.mock() during development).
//   RoomNet     talks to our own Durable Object room (src/room.ts) when the
//               page is opened on its own.
//
// The game (app.js) only ever sees this surface:
//
//   net.me, net.participants, net.isHost, net.hosted
//   net.on("join" | "leave" | "host" | "event" | "state" | "pause" | "resume", fn)
//   net.pose(obj)           my avatar, every frame; throttled to 15 Hz
//   net.poseOf(pk)          their avatar, interpolated
//   net.poseAge(pk)         ms since their last pose
//   net.event(obj, toPk?)   fire-and-tell; my own handler runs first
//   net.setState(obj)       the shared room state (last write wins)
//   net.state               the current room state
//   net.now()               the shared clock
//   net.result(text)        offer the result string (Solfray only)
//
// SOLFRAY TIE-IN: SolfrayNet is thin on purpose. Every method is a one-line
// call into the SDK, which is the point: Solfray already does roster, relay,
// interpolation, host election, and the shared clock. RoomNet re-implements
// just enough of that for the standalone site, with the same semantics, so
// nothing in the game has to know which one it is talking to.

/** Solfray.colorOf, copied so standalone rooms get the same colors even when
 *  the SDK failed to load: hue = (h*31 + charCode) % 360, hsl(h, 70%, 55%). */
export function colorOf(pk) {
  if (globalThis.Solfray && typeof globalThis.Solfray.colorOf === "function") return globalThis.Solfray.colorOf(pk);
  let h = 0;
  for (let i = 0; i < pk.length; i++) h = (h * 31 + pk.charCodeAt(i)) % 360;
  const hh = h / 360, s = 0.7, l = 0.55;
  const q = l + s - l * s, p = 2 * l - q;
  const ch = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return "#" + ch(hh + 1 / 3) + ch(hh) + ch(hh - 1 / 3);
}

class Emitter {
  constructor() {
    this._h = {};
  }
  on(ev, fn) {
    (this._h[ev] ||= []).push(fn);
    return this;
  }
  emit(ev, ...args) {
    for (const fn of this._h[ev] || []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

// ---------------------------------------------------------------------------

export class SolfrayNet extends Emitter {
  constructor(sf) {
    super();
    this.sf = sf;
    this.hosted = true;
    this.kind = "solfray";
    // SOLFRAY TIE-IN: sf.me / sf.participants carry pk, display, pfp, color,
    // anon, join_seq, role. We pass them through untouched.
    sf.on("join", (p) => this.emit("join", p));
    sf.on("leave", (p) => this.emit("leave", p));
    sf.on("host", (h) => this.emit("host", h));
    sf.on("event", (from, data, meta) => this.emit("event", from, data, meta));
    sf.on("state", (s) => this.emit("state", s));
    sf.on("pause", () => this.emit("pause"));
    sf.on("resume", () => this.emit("resume"));
    sf.on("profile", (p) => this.emit("profile", p));
  }
  get me() {
    return this.sf.me;
  }
  get participants() {
    return this.sf.participants;
  }
  get isHost() {
    return this.sf.isHost;
  }
  get state() {
    return this.sf.state;
  }
  get connected() {
    return this.sf.connected !== false;
  }
  pose(obj) {
    // 15 Hz stream with wrap-around for the two angle fields (guide 4c).
    this.sf.pose(obj, { hz: 15, angles: ["yaw", "pitch"] });
  }
  poseOf(pk) {
    return this.sf.poseOf(pk);
  }
  poseAge(pk) {
    return this.sf.poseAge(pk);
  }
  event(data, toPk) {
    this.sf.event(data, toPk);
  }
  setState(obj) {
    this.sf.setState(obj);
  }
  now() {
    return this.sf.now();
  }
  result(text) {
    this.sf.result(text);
  }
  async token() {
    // SOLFRAY TIE-IN: the playable token (guide 7a). Used by api.js.
    return this.sf.token();
  }
}

// ---------------------------------------------------------------------------

const POSE_HZ = 15;

export class RoomNet extends Emitter {
  /** @param url ws(s)://host/ws/room/<id> */
  constructor(url) {
    super();
    this.url = url;
    this.hosted = false;
    this.kind = "room";
    this.me = null;
    this.participants = [];
    this.hostSeq = null;
    this.state = null;
    this.stateSeq = 0;
    this.connected = false;
    this.offset = 0; // server clock minus ours
    this._poses = new Map(); // pk -> {a, b, at, interval}
    this._lastPoseAt = 0;
    this._pendingPose = null;
    this._backoff = 500;
    this._closed = false;
    this.ready = new Promise((res) => (this._readyResolve = res));
    this._open();
  }

  _open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this._backoff = 500;
      this._ping();
    };
    ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.connected) this.emit("pause");
      this.connected = false;
      if (this._closed) return;
      setTimeout(() => this._open(), this._backoff);
      this._backoff = Math.min(8000, this._backoff * 2);
    };
    ws.onerror = () => {};
  }

  close() {
    this._closed = true;
    try {
      this.ws.close();
    } catch {}
  }

  _send(m) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  _ping() {
    this._pingSent = performance.now();
    this._send({ t: "ping", c: Date.now() });
  }

  _onMessage(m) {
    switch (m.t) {
      case "ready": {
        const wasConnected = this.connected;
        this.connected = true;
        this.me = decorate(m.me);
        this.participants = m.participants.map(decorate);
        this.hostSeq = m.host_seq;
        if (m.state) {
          this.state = m.state.data;
          this.stateSeq = m.state.seq;
        }
        this._readyResolve(this);
        if (wasConnected === false && this._everReady) this.emit("resume");
        this._everReady = true;
        break;
      }
      case "pong": {
        // Half the round trip is our best guess for one-way latency.
        const rtt = performance.now() - this._pingSent;
        const serverNow = m.t_now + rtt / 2;
        const sample = serverNow - Date.now();
        this.offset = this.offset === 0 ? sample : this.offset * 0.8 + sample * 0.2;
        setTimeout(() => this._ping(), 5000);
        break;
      }
      case "join": {
        const p = decorate(m.participant);
        this.participants = this.participants.filter((q) => q.pk !== p.pk).concat(p).sort((a, b) => a.join_seq - b.join_seq);
        if (this.hostSeq === null) this.hostSeq = p.join_seq;
        this.emit("join", p);
        break;
      }
      case "leave": {
        const p = this.participants.find((q) => q.pk === m.pk);
        this.participants = this.participants.filter((q) => q.pk !== m.pk);
        this._poses.delete(m.pk);
        const prevHost = this.hostSeq;
        this.hostSeq = m.host_seq;
        if (p) this.emit("leave", p);
        if (prevHost !== this.hostSeq) this.emit("host", { host_seq: this.hostSeq, pk: this.hostPk });
        break;
      }
      case "pose": {
        const now = performance.now();
        let rec = this._poses.get(m.from);
        if (!rec) {
          rec = { a: m.d, b: m.d, at: now, interval: 1000 / POSE_HZ };
          this._poses.set(m.from, rec);
        } else {
          rec.interval = Math.min(500, Math.max(30, rec.interval * 0.8 + (now - rec.at) * 0.2));
          rec.a = rec.b;
          rec.b = m.d;
          rec.at = now;
        }
        break;
      }
      case "event":
        this.emit("event", m.from, m.d, { id: m.id, t: m.t_now });
        break;
      case "relay":
        this.emit("relay", m.from, m.d);
        break;
      case "state":
        if (m.seq < this.stateSeq) break;
        this.stateSeq = m.seq;
        this.state = m.data;
        this.emit("state", m.data, m.from);
        break;
      case "err":
        this.emit("error", m.code);
        break;
    }
  }

  get hostPk() {
    const h = this.participants.find((p) => p.join_seq === this.hostSeq);
    return h ? h.pk : null;
  }
  get isHost() {
    return Boolean(this.me && this.hostSeq !== null && this.me.join_seq === this.hostSeq);
  }

  pose(obj) {
    const now = performance.now();
    if (now - this._lastPoseAt < 1000 / POSE_HZ) return;
    this._lastPoseAt = now;
    this._send({ t: "pose", d: obj });
    // Our own pose is readable too, instantly, like sf.poseOf(sf.me.pk).
    if (this.me) this._poses.set(this.me.pk, { a: obj, b: obj, at: now, interval: 1000 / POSE_HZ, own: true });
  }

  /** Blend the last two poses one interval behind, wrapping yaw/pitch. */
  poseOf(pk) {
    const r = this._poses.get(pk);
    if (!r) return null;
    if (r.own) return r.b;
    const t = Math.min(1, (performance.now() - r.at) / r.interval);
    const out = {};
    for (const k of Object.keys(r.b)) {
      const a = r.a[k], b = r.b[k];
      if (typeof a !== "number" || typeof b !== "number") {
        out[k] = b;
        continue;
      }
      if (k === "yaw" || k === "pitch") {
        let d = b - a;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        out[k] = a + d * t;
      } else out[k] = a + (b - a) * t;
    }
    return out;
  }

  poseAge(pk) {
    const r = this._poses.get(pk);
    return r ? performance.now() - r.at : Infinity;
  }

  event(data, toPk) {
    // Fire and tell: our own handler runs now, everyone else's on arrival.
    this.emit("event", this.me ? this.me.pk : null, data, { id: null, t: this.now(), local: true });
    this._send({ t: "event", d: data, to: toPk });
  }

  setState(obj) {
    this._send({ t: "state", data: obj });
  }

  now() {
    return Date.now() + this.offset;
  }

  result(text) {
    // No host chrome to hand it to; the page's own Copy button covers it.
    console.log("[rift-builder] result:\n" + text);
  }
}

/** Give a room participant the same fields a Solfray participant has. */
function decorate(p) {
  return { ...p, color: colorOf(p.pk), pfp: null, role: "player" };
}
