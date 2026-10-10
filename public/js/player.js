// player.js: the local first-person controller and its grid collision.
//
// SOLFRAY TIE-IN (guide 4c, "you own your stuff"): this page owns its own
// avatar. Movement is applied locally the instant input happens and the
// resulting pose is streamed with net.pose() from the game loop; nothing here
// waits for a host or a server. Other players are drawn from net.poseOf().

import * as THREE from "three";

export const PLAYER = { radius: 0.3, height: 1.8, eye: 1.62, speed: 5.5, sprint: 8.5, jump: 7.5, gravity: 20, flySpeed: 12 };

export class Player {
  constructor() {
    this.pos = new THREE.Vector3(); // feet, centre of the capsule footprint
    this.vel = new THREE.Vector3();
    this.yaw = 0; // radians, 0 looks toward +Z
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.keys = new Set();
    this.lastTeleport = 0;
  }

  respawn(world) {
    const [x, y, z, yaw] = world.spawn;
    this.pos.set(x + 0.5, y, z + 0.5);
    // If the spawn cell is inside a block, climb until clear.
    for (let i = 0; i < 20 && this.collides(world); i++) this.pos.y += 1;
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
  }

  eye() {
    return new THREE.Vector3(this.pos.x, this.pos.y + PLAYER.eye, this.pos.z);
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

  update(dt, world) {
    const k = this.keys;
    const fwd = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const str = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // Note the strafe sign: with yaw=0 facing +Z, "right" is -X.
    const wishX = sy * fwd - cy * str;
    const wishZ = cy * fwd + sy * str;
    const len = Math.hypot(wishX, wishZ) || 1;

    if (this.flying) {
      const sp = PLAYER.flySpeed * (k.has("ShiftLeft") ? 2 : 1);
      this.vel.set((wishX / len) * sp * (fwd || str ? 1 : 0), 0, (wishZ / len) * sp * (fwd || str ? 1 : 0));
      this.vel.y = (k.has("Space") ? sp : 0) - (k.has("ControlLeft") || k.has("KeyC") ? sp : 0);
      this.pos.addScaledVector(this.vel, dt);
      return;
    }

    const sp = k.has("ShiftLeft") ? PLAYER.sprint : PLAYER.speed;
    const target = new THREE.Vector3((wishX / len) * sp * (fwd || str ? 1 : 0), 0, (wishZ / len) * sp * (fwd || str ? 1 : 0));
    // Ground control is snappy, air control is loose: gives rift flings a
    // bit of momentum without being slippery to walk.
    const accel = this.onGround ? 14 : 3.5;
    this.vel.x += (target.x - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (target.z - this.vel.z) * Math.min(1, accel * dt);
    if (k.has("Space") && this.onGround) {
      this.vel.y = PLAYER.jump;
      this.onGround = false;
    }
    this.vel.y -= PLAYER.gravity * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    this.moveAxis(world, "x", this.vel.x * dt);
    this.moveAxis(world, "z", this.vel.z * dt);
    const before = this.vel.y;
    this.moveAxis(world, "y", this.vel.y * dt);
    this.onGround = before < 0 && this.vel.y === 0;
  }

  /** Move along one axis, backing out of any solid cell and killing velocity. */
  moveAxis(world, axis, delta) {
    if (!delta) return;
    this.pos[axis] += delta;
    if (this.collides(world)) {
      // Step back to the cell boundary.
      const r = axis === "y" ? 0 : PLAYER.radius;
      if (delta > 0) {
        const edge = axis === "y" ? this.pos.y + PLAYER.height : this.pos[axis] + r;
        this.pos[axis] -= edge - Math.floor(edge) + 0.001;
      } else {
        const edge = this.pos[axis] - r;
        this.pos[axis] += Math.ceil(edge) - edge + 0.001;
      }
      if (this.collides(world)) this.pos[axis] -= delta; // give up, undo
      this.vel[axis] = 0;
    }
  }

  collides(world) {
    const r = PLAYER.radius;
    const x0 = Math.floor(this.pos.x - r), x1 = Math.floor(this.pos.x + r);
    const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + PLAYER.height - 0.001);
    const z0 = Math.floor(this.pos.z - r), z1 = Math.floor(this.pos.z + r);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (world.isSolid(x, y, z)) return true;
    return false;
  }

  /** The cells the player's body overlaps, for goal/hazard checks. */
  touching(world, type) {
    const r = PLAYER.radius + 0.05;
    const x0 = Math.floor(this.pos.x - r), x1 = Math.floor(this.pos.x + r);
    const y0 = Math.floor(this.pos.y - 0.1), y1 = Math.floor(this.pos.y + PLAYER.height);
    const z0 = Math.floor(this.pos.z - r), z1 = Math.floor(this.pos.z + r);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (world.get(x, y, z) === type) return true;
    return false;
  }

  /** The compact pose streamed to other players. */
  pose() {
    const q = (v) => Math.round(v * 100) / 100;
    return { x: q(this.pos.x), y: q(this.pos.y), z: q(this.pos.z), yaw: q(this.yaw), pitch: q(this.pitch) };
  }
}
