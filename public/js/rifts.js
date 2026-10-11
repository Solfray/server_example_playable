// rifts.js: linked rifts. Place two on light panels; step through one, come
// out of the other, momentum and all. Every player carries their own pair
// and anyone may use anyone's.
//
// The name is "rift" on purpose: the idea of linked portals in a game is not
// anyone's property, but the names, art, voices, and characters of existing
// games are, so nothing here borrows them.
//
// SOLFRAY TIE-IN (guide 4c, rule 4, "fire and tell"): placing a rift is an
// event. The placing page runs its own handler at once, then every other page
// runs the same handler when the event arrives, so everyone ends up with the
// same rift in the same place. There is no server-side truth for rifts and no
// host involvement; they are cosmetic-plus-teleport, and a disagreement would
// only mean two players see a rift a few centimetres apart.

import * as THREE from "three";
import { BLOCK_INFO, isStair, STAIR_DIR, stairRot, stairFlipped } from "./world.js";

export const RX = 0.45; // half width
export const RY = 0.9; // half height
const ROT_Y_PI = new THREE.Matrix4().makeRotationY(Math.PI);

const COLORS = { a: new THREE.Color(0x3fa9ff), b: new THREE.Color(0xff9a3f) };

const portalShader = {
  vertex: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: `
    uniform sampler2D tex; uniform vec2 res; uniform float time; uniform vec3 color; uniform int mode;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv * 2.0 - 1.0;
      float r = length(c);
      if (r > 1.0) discard;
      if (mode == 1) {
        // Screen-space lookup: the texture was rendered with the same
        // projection as the main camera, so the pixel under this fragment is
        // exactly what the virtual camera saw there.
        vec2 uv = gl_FragCoord.xy / res;
        vec3 col = texture2D(tex, uv).rgb;
        float edge = smoothstep(0.82, 1.0, r);
        gl_FragColor = vec4(mix(col, color, edge * 0.9), 1.0);
      } else {
        float a = atan(c.y, c.x);
        float s = 0.5 + 0.5 * sin(9.0 * r - time * 3.0 + a * 2.0);
        float glow = smoothstep(0.6, 1.0, r);
        vec3 col = mix(color * 0.15, color * 0.9, s * 0.6 + glow * 0.5);
        gl_FragColor = vec4(col, 1.0);
      }
    }`,
};

export class Rifts {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.byOwner = new Map(); // pk -> { a: Rift|null, b: Rift|null }
    this.targets = {
      a: new THREE.WebGLRenderTarget(2, 2),
      b: new THREE.WebGLRenderTarget(2, 2),
    };
    this.vcam = new THREE.PerspectiveCamera();
    this.vcam.matrixAutoUpdate = false;
    this.time = 0;
  }

  pairOf(pk) {
    let p = this.byOwner.get(pk);
    if (!p) {
      p = { a: null, b: null };
      this.byOwner.set(pk, p);
    }
    return p;
  }

  /** Work out where a rift would go for a shot from `origin` along `dir`.
   *  Returns a placement {x,y,z,nx,ny,nz,ux,uy,uz} or null when the surface
   *  cannot take one. Pure: nothing is placed. */
  aim(world, origin, dir, yaw) {
    const hit = world.raycast(origin, dir, 48, false);
    if (!hit) return null;
    if (!BLOCK_INFO[hit.t] || !BLOCK_INFO[hit.t].riftable) return null;
    if (isStair(hit.t)) return this.aimSlope(world, hit);
    const n = new THREE.Vector3(hit.nx, hit.ny, hit.nz);
    // The long axis of the oval: world up on walls, the shooter's heading
    // snapped to an axis on floors and ceilings.
    let up;
    if (n.y === 0) up = new THREE.Vector3(0, 1, 0);
    else up = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? new THREE.Vector3(Math.sign(Math.sin(yaw)) || 1, 0, 0) : new THREE.Vector3(0, 0, Math.sign(Math.cos(yaw)) || 1);
    const cell = new THREE.Vector3(hit.x, hit.y, hit.z);
    const faceCenter = cell.clone().addScalar(0.5).addScaledVector(n, 0.5);
    // Which neighbour along `up` joins this cell to make the 1x2 footprint?
    // Prefer the side the shot landed on.
    const frac = hit.point.clone().sub(cell).dot(up) - 0.5; // -0.5..0.5 along up
    const candidates = frac >= 0 ? [1, -1] : [-1, 1];
    for (const side of candidates) {
      const other = cell.clone().addScaledVector(up, side);
      const cells = side > 0 ? [cell, other] : [other, cell];
      if (!cells.every((c) => BLOCK_INFO[world.get(c.x, c.y, c.z)]?.riftable && !isStair(world.get(c.x, c.y, c.z)))) continue;
      // The two cells in front of the footprint must be open air.
      if (cells.some((c) => world.isSolid(c.x + n.x, c.y + n.y, c.z + n.z))) continue;
      const center = faceCenter.clone().addScaledVector(up, side * 0.5);
      // Not on top of an existing rift of the same facing.
      let blocked = false;
      for (const pair of this.byOwner.values())
        for (const r of [pair.a, pair.b]) if (r && r.pos.distanceTo(center) < 1.2 && r.normal.dot(n) > 0.5) blocked = true;
      if (blocked) continue;
      return {
        x: Math.round(center.x * 100) / 100,
        y: Math.round(center.y * 100) / 100,
        z: Math.round(center.z * 100) / 100,
        nx: n.x, ny: n.y, nz: n.z,
        ux: up.x, uy: up.y, uz: up.z,
        cells: cells.map((c) => [c.x, c.y, c.z]),
      };
    }
    return null;
  }

  /** A rift on a slope. Stairs are the game's slopes: a run of two matching
   *  stair cells, one diagonal step apart, is a 45-degree surface 2.8 units
   *  long, enough for the 1.8-unit oval. The rift's normal points up and
   *  out of the slope; its long axis runs along the climb. The two stair
   *  cells (plus the block under the upper step) are the backing cells the
   *  player may pass through. Upside-down
   *  stairs do not take rifts. */
  aimSlope(world, hit) {
    const meta = hit.meta;
    if (stairFlipped(meta)) return null;
    const d = STAIR_DIR[stairRot(meta)];
    const up = new THREE.Vector3(0, 1, 0);
    const same = (x, y, z) => world.get(x, y, z) === hit.t && world.meta(x, y, z) === meta;
    const c = new THREE.Vector3(hit.x, hit.y, hit.z);
    // The hit cell is either the lower or the upper step of the run.
    let lower = null;
    if (same(c.x + d.x, c.y + 1, c.z + d.z)) lower = c;
    else if (same(c.x - d.x, c.y - 1, c.z - d.z)) lower = c.clone().sub(d).sub(up);
    if (!lower) return null;
    const upper = lower.clone().add(d).add(up);
    // Headroom: the cells above both steps must be open.
    if (world.isSolid(lower.x, lower.y + 1, lower.z) || world.isSolid(upper.x, upper.y + 1, upper.z)) return null;
    const n = up.clone().sub(d).normalize(); // out of the slope, upward
    const along = up.clone().add(d).normalize(); // along the climb
    // The diagonal through the step corners cuts the risers; float the oval
    // just above the riser tips (0.5 vertical = 0.354 along the normal).
    const center = new THREE.Vector3(lower.x + 0.5 + d.x * 0.5, lower.y + 1, lower.z + 0.5 + d.z * 0.5).addScaledVector(n, 0.36);
    for (const pair of this.byOwner.values())
      for (const r of [pair.a, pair.b]) if (r && r.pos.distanceTo(center) < 1.2 && r.normal.dot(n) > 0.5) return null;
    const q = (v) => Math.round(v * 1000) / 1000;
    return {
      x: q(center.x), y: q(center.y), z: q(center.z),
      nx: q(n.x), ny: q(n.y), nz: q(n.z),
      ux: q(along.x), uy: q(along.y), uz: q(along.z),
      // Backing cells: both steps and the block under the upper step, so a
      // player walking up the slope can reach the plane instead of bumping
      // into the riser beneath it.
      cells: [[lower.x, lower.y, lower.z], [upper.x, upper.y, upper.z], [lower.x + d.x, lower.y, lower.z + d.z]],
    };
  }

  /** Put a rift down from a placement (local or from another player's event). */
  place(pk, which, p) {
    const pair = this.pairOf(pk);
    if (pair[which]) this.remove(pk, which);
    const rift = new Rift(pk, which, p);
    pair[which] = rift;
    this.group.add(rift.group);
    return rift;
  }

  remove(pk, which) {
    const pair = this.pairOf(pk);
    const r = pair[which];
    if (!r) return;
    this.group.remove(r.group);
    r.dispose();
    pair[which] = null;
  }

  removeAll(pk) {
    this.remove(pk, "a");
    this.remove(pk, "b");
    this.byOwner.delete(pk);
  }

  clear() {
    for (const pk of [...this.byOwner.keys()]) this.removeAll(pk);
  }

  /** Complete pairs: both rifts exist. */
  *pairs() {
    for (const pair of this.byOwner.values()) if (pair.a && pair.b) yield pair;
  }

  /** Cells the player may pass through right now: the backing cells of any
   *  complete rift whose oval the player's centre is inside (in its plane). */
  passable(center) {
    const out = new Set();
    const l = new THREE.Vector3();
    for (const pair of this.pairs())
      for (const r of [pair.a, pair.b]) {
        l.copy(center).applyMatrix4(r.inv);
        if ((l.x / (RX + 0.3)) ** 2 + (l.y / (RY + 0.2)) ** 2 < 1 && l.z > -1.2 && l.z < 1.5) for (const c of r.cells) out.add(c.join(","));
      }
    return out;
  }

  /** Did the segment prev->cur cross a complete rift? Returns the transform
   *  (Matrix4 mapping entry-side space to exit-side space) and the exit. */
  crossing(prev, cur) {
    const lp = new THREE.Vector3(), lc = new THREE.Vector3();
    for (const pair of this.pairs()) {
      for (const [from, to] of [[pair.a, pair.b], [pair.b, pair.a]]) {
        lp.copy(prev).applyMatrix4(from.inv);
        lc.copy(cur).applyMatrix4(from.inv);
        if (lp.z > 0 && lc.z <= 0) {
          const t = lp.z / (lp.z - lc.z);
          const hx = lp.x + (lc.x - lp.x) * t, hy = lp.y + (lc.y - lp.y) * t;
          if ((hx / RX) ** 2 + (hy / RY) ** 2 <= 1) {
            const m = new THREE.Matrix4().multiplyMatrices(to.matrix, ROT_Y_PI).multiply(from.inv);
            return { m, from, to };
          }
        }
      }
    }
    return null;
  }

  /** Render what the local player's own pair sees, into two textures. Call
   *  before the main render. */
  renderViews(scene, camera, myPk) {
    this.time += 1 / 60;
    for (const pair of this.byOwner.values())
      for (const r of [pair.a, pair.b]) if (r) r.surface.material.uniforms.time.value = this.time;
    const pair = this.byOwner.get(myPk);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const scale = 0.6; // the textures are sampled by screen position, so a lower resolution just blurs a little
    const tw = Math.max(2, Math.floor(size.x * scale)), th = Math.max(2, Math.floor(size.y * scale));
    for (const which of ["a", "b"]) {
      const target = this.targets[which];
      if (target.width !== tw || target.height !== th) target.setSize(tw, th);
    }
    if (!pair || !pair.a || !pair.b) {
      if (pair) for (const r of [pair.a, pair.b]) if (r) r.setMode(0);
      return;
    }
    const prevTarget = this.renderer.getRenderTarget();
    const prevClip = this.renderer.clippingPlanes;
    pair.a.group.visible = false;
    pair.b.group.visible = false;
    for (const [from, to] of [[pair.a, pair.b], [pair.b, pair.a]]) {
      // Virtual camera: where the real camera would be if the two rifts
      // were the same hole seen from the other side.
      const m = new THREE.Matrix4().multiplyMatrices(to.matrix, ROT_Y_PI).multiply(from.inv).multiply(camera.matrixWorld);
      this.vcam.matrixWorld.copy(m);
      this.vcam.matrixWorldInverse.copy(m).invert();
      this.vcam.projectionMatrix.copy(camera.projectionMatrix);
      this.vcam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      // Clip everything behind the exit rift's plane so the wall it sits in
      // does not cover the view.
      this.renderer.clippingPlanes = [new THREE.Plane(to.normal.clone(), -to.normal.dot(to.pos) + 0.01)];
      this.renderer.setRenderTarget(this.targets[from.which]);
      this.renderer.clear();
      this.renderer.render(scene, this.vcam);
      from.surface.material.uniforms.tex.value = this.targets[from.which].texture;
      from.surface.material.uniforms.res.value.set(size.x, size.y);
      from.setMode(1);
    }
    this.renderer.clippingPlanes = prevClip;
    this.renderer.setRenderTarget(prevTarget);
    pair.a.group.visible = true;
    pair.b.group.visible = true;
  }

  dispose() {
    this.clear();
    this.targets.a.dispose();
    this.targets.b.dispose();
  }
}

class Rift {
  constructor(pk, which, p) {
    this.pk = pk;
    this.which = which;
    this.pos = new THREE.Vector3(p.x, p.y, p.z);
    this.normal = new THREE.Vector3(p.nx, p.ny, p.nz);
    this.up = new THREE.Vector3(p.ux, p.uy, p.uz);
    this.cells = p.cells || [];
    // Local frame: +Z out of the surface, +Y along the long axis.
    const right = new THREE.Vector3().crossVectors(this.up, this.normal);
    this.matrix = new THREE.Matrix4().makeBasis(right, this.up, this.normal).setPosition(this.pos.clone().addScaledVector(this.normal, 0.02));
    this.inv = this.matrix.clone().invert();
    this.color = COLORS[which];

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(this.matrix);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.93, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: this.color, side: THREE.DoubleSide })
    );
    ring.scale.set(RX * 1.08, RY * 1.04, 1);
    ring.position.z = 0.005;
    this.group.add(ring);

    this.surface = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.ShaderMaterial({
        vertexShader: portalShader.vertex,
        fragmentShader: portalShader.fragment,
        uniforms: {
          tex: { value: null },
          res: { value: new THREE.Vector2(1, 1) },
          time: { value: 0 },
          color: { value: this.color },
          mode: { value: 0 },
        },
        side: THREE.DoubleSide,
      })
    );
    this.surface.scale.set(RX, RY, 1);
    this.group.add(this.surface);
  }
  setMode(m) {
    this.surface.material.uniforms.mode.value = m;
  }
  dispose() {
    for (const c of this.group.children) {
      c.geometry.dispose();
      c.material.dispose();
    }
  }
}
