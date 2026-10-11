// player.js: the local first-person controller and its grid collision.
//
// Controls follow the conventions of block-building games so nobody has to
// learn anything: WASD, Space jumps, Shift sneaks, Ctrl sprints, and in build
// mode a double tap on Space toggles flight (Space up, Shift down). Numbers
// are the usual ones for a 1.8-tall, 0.6-wide player: eye at 1.62 (1.27 when
// sneaking), walk 4.3 m/s, sprint 5.6, sneak 1.3, jump a little over one
// block, and a 0.6 step-up so stairs and slabs are walked, not jumped.
//
// SOLFRAY TIE-IN (guide 4c, "you own your stuff"): this page owns its own
// avatar. Movement is applied locally the instant input happens and the
// resulting pose is streamed with net.pose() from the game loop; nothing here
// waits for a host or a server. Other players are drawn from net.poseOf().

import * as THREE from "three";

export const PLAYER = {
  radius: 0.3,
  height: 1.8,
  sneakHeight: 1.5,
  eye: 1.62,
  sneakEye: 1.27,
  walk: 4.3,
  sprint: 5.6,
  sneak: 1.3,
  jump: 8.4,
  gravity: 30,
  stepHeight: 0.6,
  fly: 10.9,
  flySprint: 21.8,
  flyVertical: 7.5,
  reach: 5, // block reach in build mode
};

export class Player {
  constructor() {
    this.pos = new THREE.Vector3(); // feet, centre of the footprint
    this.vel = new THREE.Vector3();
    this.yaw = 0; // radians, 0 looks toward +Z
    this.pitch = 0;
    this.onGround = false;
    this.mode = "survival"; // "survival" | "creative"
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.keys = new Set();
    this.lastSpaceTap = -1;
    this.lastTeleport = 0;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== "creative") this.flying = false;
  }

  respawn(world) {
    const [x, y, z, yaw] = world.spawn;
    this.pos.set(x + 0.5, y, z + 0.5);
    // If the spawn cell is inside a block, climb until clear.
    for (let i = 0; i < 20 && this.collides(world); i++) this.pos.y += 1;
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.flying = false;
  }

  get bodyHeight() {
    return this.sneaking && !this.flying ? PLAYER.sneakHeight : PLAYER.height;
  }

  eyeHeight() {
    return this.sneaking && !this.flying ? PLAYER.sneakEye : PLAYER.eye;
  }

  eye() {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z);
  }

  /** Centre of the body, the point rifts test against. */
  center(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 0.9, this.pos.z);
  }

  forward() {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0022;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0022));
  }

  clearKeys() {
    this.keys.clear();
  }

  /** Key press hook for things that are edges, not levels: the double-tap
   *  on Space that toggles flight in build mode. Call from keydown. */
  keyPressed(code, timeMs) {
    if (code !== "Space" || this.mode !== "creative") return;
    if (timeMs - this.lastSpaceTap < 300) {
      this.flying = !this.flying;
      this.vel.set(0, 0, 0);
      this.lastSpaceTap = -1;
    } else this.lastSpaceTap = timeMs;
  }

  update(dt, world) {
    const k = this.keys;
    const fwd = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const str = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const moving = fwd || str;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // Note the strafe sign: with yaw=0 facing +Z, "right" is -X.
    const len = Math.hypot(fwd, str) || 1;
    const wishX = (sy * fwd - cy * str) / len;
    const wishZ = (cy * fwd + sy * str) / len;
    const shift = k.has("ShiftLeft") || k.has("ShiftRight");
    const ctrl = k.has("ControlLeft") || k.has("ControlRight");

    if (this.flying) {
      this.sneaking = false;
      this.sprinting = ctrl && moving;
      const sp = this.sprinting ? PLAYER.flySprint : PLAYER.fly;
      const target = new THREE.Vector3(wishX * sp * (moving ? 1 : 0), 0, wishZ * sp * (moving ? 1 : 0));
      target.y = (k.has("Space") ? PLAYER.flyVertical : 0) - (shift ? PLAYER.flyVertical : 0);
      // Flight is floaty but not slippery.
      this.vel.lerp(target, Math.min(1, 10 * dt));
      this.moveAxis(world, "x", this.vel.x * dt);
      this.moveAxis(world, "z", this.vel.z * dt);
      const before = this.vel.y;
      this.moveAxis(world, "y", this.vel.y * dt);
      // Flying down onto the ground lands you, as in creative mode.
      if (before < 0 && this.vel.y === 0 && shift) {
        this.flying = false;
        this.onGround = true;
      }
      return;
    }

    // Sneaking shrinks the body; only stand back up when there is headroom.
    const wantSneak = shift && this.onGround;
    if (wantSneak) this.sneaking = true;
    else if (this.sneaking) {
      this.sneaking = false;
      if (this.collides(world)) this.sneaking = true;
    }
    this.sprinting = ctrl && moving && !this.sneaking && fwd > 0;

    const sp = this.sneaking ? PLAYER.sneak : this.sprinting ? PLAYER.sprint : PLAYER.walk;
    const tx = wishX * sp * (moving ? 1 : 0), tz = wishZ * sp * (moving ? 1 : 0);
    // Ground control is snappy, air control is loose: gives rift flings a
    // bit of momentum without being slippery to walk.
    const accel = this.onGround ? 16 : 3.5;
    this.vel.x += (tx - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (tz - this.vel.z) * Math.min(1, accel * dt);
    if (k.has("Space") && this.onGround) {
      this.vel.y = PLAYER.jump;
      // A sprint jump carries a little further.
      if (this.sprinting) {
        this.vel.x *= 1.15;
        this.vel.z *= 1.15;
      }
      this.onGround = false;
    }
    this.vel.y -= PLAYER.gravity * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    const wasOnGround = this.onGround;
    const startX = this.pos.x, startZ = this.pos.z;
    this.moveHorizontal(world, this.vel.x * dt, this.vel.z * dt, wasOnGround);
    if (this.sneaking && wasOnGround) this.sneakGuard(world, startX, startZ);
    const before = this.vel.y;
    this.moveAxis(world, "y", this.vel.y * dt);
    this.onGround = before < 0 && this.vel.y === 0;
  }

  /** Horizontal move with step-up: if a low obstacle blocks the way and we
   *  are on the ground, try the same move from up to stepHeight higher and
   *  settle back down. Stairs and slabs are climbed this way. */
  moveHorizontal(world, dx, dz, canStep) {
    const ox = this.pos.x, oz = this.pos.z, oy = this.pos.y;
    const ovx = this.vel.x, ovz = this.vel.z;
    this.moveAxis(world, "x", dx);
    this.moveAxis(world, "z", dz);
    const flatX = this.pos.x, flatZ = this.pos.z;
    const flatDist = Math.hypot(flatX - ox, flatZ - oz);
    const wanted = Math.hypot(dx, dz);
    if (!canStep || flatDist >= wanted - 1e-6) return;
    // Blocked: retry from a raised position.
    const fvx = this.vel.x, fvz = this.vel.z;
    this.pos.set(ox, oy, oz);
    this.vel.x = ovx;
    this.vel.z = ovz;
    this.pos.y += PLAYER.stepHeight;
    if (this.collides(world)) {
      this.pos.set(flatX, oy, flatZ);
      this.vel.x = fvx;
      this.vel.z = fvz;
      return;
    }
    this.moveAxis(world, "x", dx);
    this.moveAxis(world, "z", dz);
    const stepDist = Math.hypot(this.pos.x - ox, this.pos.z - oz);
    // Settle down onto whatever we stepped onto.
    this.moveAxis(world, "y", -PLAYER.stepHeight);
    if (stepDist > flatDist + 1e-4 && this.pos.y >= oy - 1e-6) return; // stepped up
    // No better: keep the flat result.
    this.pos.set(flatX, oy, flatZ);
    this.vel.x = fvx;
    this.vel.z = fvz;
  }

  /** Sneaking never walks off an edge: undo a horizontal move that leaves no
   *  ground under the feet. */
  sneakGuard(world, startX, startZ) {
    if (this.groundBelow(world)) return;
    const nx = this.pos.x;
    // Keep the z move only?
    this.pos.x = startX;
    if (this.groundBelow(world)) {
      this.vel.x = 0;
      return;
    }
    // Keep the x move only?
    this.pos.x = nx;
    this.pos.z = startZ;
    if (this.groundBelow(world)) {
      this.vel.z = 0;
      return;
    }
    // Neither: stay put.
    this.pos.x = startX;
    this.pos.z = startZ;
    this.vel.x = this.vel.z = 0;
  }

  groundBelow(world) {
    const r = PLAYER.radius;
    const y0 = this.pos.y - 0.06, y1 = this.pos.y - 0.001;
    return this.overlapsAny(world, this.pos.x - r, y0, this.pos.z - r, this.pos.x + r, y1, this.pos.z + r);
  }

  /** Move along one axis, resolving against every collider box the move
   *  entered. Boxes we already overlapped before the move are ignored, so a
   *  player who ends up inside something (a rift exit against a wall, a
   *  block placed on them) can always walk out instead of being pinned. */
  moveAxis(world, axis, delta) {
    if (!delta) return;
    const r = PLAYER.radius, h = this.bodyHeight;
    const key = (b) => b.join(",");
    const pre = new Set(this.overlapping(world, this.pos.x - r, this.pos.y, this.pos.z - r, this.pos.x + r, this.pos.y + h, this.pos.z + r).map(key));
    this.pos[axis] += delta;
    for (let pass = 0; pass < 3; pass++) {
      const boxes = this.overlapping(world, this.pos.x - r, this.pos.y, this.pos.z - r, this.pos.x + r, this.pos.y + h, this.pos.z + r).filter((b) => !pre.has(key(b)));
      if (!boxes.length) return;
      // Push out along this axis by the smallest amount that clears every box.
      let limit = delta > 0 ? Infinity : -Infinity;
      for (const b of boxes) {
        if (axis === "y") limit = delta > 0 ? Math.min(limit, b[1] - h) : Math.max(limit, b[4]);
        else if (axis === "x") limit = delta > 0 ? Math.min(limit, b[0] - r) : Math.max(limit, b[3] + r);
        else limit = delta > 0 ? Math.min(limit, b[2] - r) : Math.max(limit, b[5] + r);
      }
      this.pos[axis] = delta > 0 ? limit - 0.001 : limit + 0.001;
      this.vel[axis] = 0;
    }
    // Still inside something new: give up and undo the move.
    const after = this.overlapping(world, this.pos.x - r, this.pos.y, this.pos.z - r, this.pos.x + r, this.pos.y + h, this.pos.z + r);
    if (after.some((b) => !pre.has(key(b)))) this.pos[axis] -= delta;
  }

  /** Collider boxes overlapping an AABB. */
  overlapping(world, x0, y0, z0, x1, y1, z1) {
    const out = [];
    const cx0 = Math.floor(x0), cx1 = Math.floor(x1 - 1e-6);
    const cy0 = Math.floor(y0), cy1 = Math.floor(y1 - 1e-6);
    const cz0 = Math.floor(z0), cz1 = Math.floor(z1 - 1e-6);
    for (let x = cx0; x <= cx1; x++)
      for (let y = cy0; y <= cy1; y++)
        for (let z = cz0; z <= cz1; z++) {
          const boxes = world.colliders(x, y, z);
          if (!boxes) continue;
          for (const b of boxes) if (b[0] < x1 && b[3] > x0 && b[1] < y1 && b[4] > y0 && b[2] < z1 && b[5] > z0) out.push(b);
        }
    return out;
  }

  overlapsAny(world, x0, y0, z0, x1, y1, z1) {
    return this.overlapping(world, x0, y0, z0, x1, y1, z1).length > 0;
  }

  collides(world) {
    const r = PLAYER.radius;
    return this.overlapsAny(world, this.pos.x - r, this.pos.y, this.pos.z - r, this.pos.x + r, this.pos.y + this.bodyHeight, this.pos.z + r);
  }

  /** Does the body overlap any cell of this type (goal, hazard)? */
  touching(world, type) {
    const r = PLAYER.radius + 0.05;
    const x0 = Math.floor(this.pos.x - r), x1 = Math.floor(this.pos.x + r);
    const y0 = Math.floor(this.pos.y - 0.1), y1 = Math.floor(this.pos.y + this.bodyHeight);
    const z0 = Math.floor(this.pos.z - r), z1 = Math.floor(this.pos.z + r);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (world.get(x, y, z) === type) return true;
    return false;
  }

  /** The compact pose streamed to other players. `c` is 1 while sneaking so
   *  their copy of us crouches too. */
  pose() {
    const q = (v) => Math.round(v * 100) / 100;
    const p = { x: q(this.pos.x), y: q(this.pos.y), z: q(this.pos.z), yaw: q(this.yaw), pitch: q(this.pitch) };
    if (this.sneaking) p.c = 1;
    return p;
  }
}
