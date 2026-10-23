// world.js: the map as a voxel grid, its Three.js meshes, and the built-in maps.
//
// A map is a grid of 1-unit cells (see src/api/maps.ts for the JSON shape the
// server validates). This module knows nothing about networking or Solfray:
// it turns map JSON into geometry and answers "what is solid here?".
//
// Cell encoding: one byte per cell. The low 5 bits are the block type, the
// high 3 bits are "meta": for stairs, bits 0-1 are the rotation (which way
// the stair climbs) and bit 2 is the upside-down flag, exactly like the
// facing + half properties of stair blocks in voxel games. Everything else
// has meta 0. The JSON form is [x, y, z, type] or [x, y, z, type, meta].

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const BLOCK = { PANEL: 1, STEEL: 2, GOAL: 3, HAZARD: 4, BUTTON: 5, DOOR: 6, GLASS: 7, STAIR: 8, STAIR_STEEL: 9 };

// Each block keeps a generated 16×16 `texture` (nearest-filtered, shared by
// every instance of that type) plus a `kind` the hotbar uses to mimic the
// in-world silhouette. `color` tints the build-mode ghost. `shape` picks a
// mesh that is not a full cube: panel (recessed frame), button (floor pad),
// exit (pad + beacon), acid (sunken pool), door (cube with a waist rail).
export const BLOCK_INFO = {
  [BLOCK.PANEL]: { name: "Panel", hint: "light panel: rifts stick to it", color: 0xd5e2f0, riftable: true, kind: "panel", shape: "panel", texture: null, swatch: "" },
  [BLOCK.STEEL]: { name: "Plate", hint: "dark plate: rifts bounce off", color: 0x6a5c48, riftable: false, kind: "plate", texture: null, swatch: "" },
  [BLOCK.GLASS]: { name: "Glass", hint: "glass: see-through, solid, not riftable", color: 0xb7e7ff, riftable: false, kind: "glass", opacity: 0.35, texture: null, swatch: "" },
  [BLOCK.STAIR]: { name: "Panel stairs", hint: "panel stairs: walkable slope, rifts stick to a two-step run", color: 0x3d9fe0, riftable: true, stair: true, nosing: true, kind: "stair", texture: null, swatch: "" },
  [BLOCK.STAIR_STEEL]: { name: "Plate stairs", hint: "plate stairs: walkable slope, rifts bounce off", color: 0xe09a3a, riftable: false, stair: true, kind: "stair plate-stair", texture: null, swatch: "" },
  [BLOCK.GOAL]: { name: "Exit", hint: "exit pad: touch it to finish", color: 0x35d07f, riftable: false, emissive: 0x1d8a52, kind: "goal", shape: "exit", texture: null, swatch: "" },
  [BLOCK.HAZARD]: { name: "Acid", hint: "acid: touching it sends you back to spawn", color: 0xc6ef1a, riftable: false, emissive: 0x6a8f00, kind: "hazard", shape: "acid", texture: null, swatch: "" },
  [BLOCK.BUTTON]: { name: "Button", hint: "floor button: stand on it to open every door", color: 0xe23b3b, riftable: false, emissive: 0x6a1818, kind: "button", shape: "button", texture: null, swatch: "" },
  [BLOCK.DOOR]: { name: "Door", hint: "door: solid until a button is held down", color: 0x3a68c8, riftable: false, kind: "door", shape: "door", texture: null, swatch: "" },
};

/** The order blocks appear in the hotbar (keys 1-9). */
export const HOTBAR = [BLOCK.PANEL, BLOCK.STEEL, BLOCK.GLASS, BLOCK.STAIR, BLOCK.STAIR_STEEL, BLOCK.GOAL, BLOCK.HAZARD, BLOCK.BUTTON, BLOCK.DOOR];

export const TYPE_MASK = 31;
export const typeOf = (cell) => cell & TYPE_MASK;
export const metaOf = (cell) => cell >> 5;
export const cellOf = (type, meta = 0) => (type & TYPE_MASK) | ((meta & 7) << 5);
export const isStair = (type) => Boolean(BLOCK_INFO[type] && BLOCK_INFO[type].stair);

/** Stair rotation -> the horizontal direction the stair climbs toward (the
 *  high step is on this side). 0:+Z 1:+X 2:-Z 3:-X. */
export const STAIR_DIR = [
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0),
];
export const stairRot = (meta) => meta & 3;
export const stairFlipped = (meta) => Boolean(meta & 4);
/** Rotation whose climb direction is closest to a horizontal heading. */
export function rotFromHeading(dx, dz) {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 0 : 2;
}

export class World {
  constructor(data) {
    this.load(data);
    this.group = new THREE.Group();
    this.meshes = {};
    this.doorsOpen = false;
    this.dirty = true;
    // Cells the local player may currently pass through: the backing cells
    // of a rift they are stepping into (set per frame by app.js).
    this.passable = null;
  }

  load(data) {
    this.size = data.size.slice();
    const [w, h, d] = this.size;
    this.cells = new Uint8Array(w * h * d);
    for (const b of data.blocks) this.cells[this.idx(b[0], b[1], b[2])] = cellOf(b[3], b[4] || 0);
    this.spawn = data.spawn.slice();
    this.dirty = true;
  }

  toJSON() {
    const blocks = [];
    const [w, h, d] = this.size;
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++)
        for (let z = 0; z < d; z++) {
          const c = this.cells[this.idx(x, y, z)];
          if (!c) continue;
          const t = typeOf(c), m = metaOf(c);
          blocks.push(m ? [x, y, z, t, m] : [x, y, z, t]);
        }
    return { schema: 1, size: this.size.slice(), spawn: this.spawn.map((v) => Math.round(v * 100) / 100), blocks };
  }

  idx(x, y, z) {
    return (x * this.size[1] + y) * this.size[2] + z;
  }

  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2];
  }

  /** Raw cell byte (type + meta). */
  raw(x, y, z) {
    return this.inBounds(x, y, z) ? this.cells[this.idx(x, y, z)] : 0;
  }

  /** Block type only. */
  get(x, y, z) {
    return typeOf(this.raw(x, y, z));
  }

  meta(x, y, z) {
    return metaOf(this.raw(x, y, z));
  }

  set(x, y, z, t, meta = 0) {
    if (!this.inBounds(x, y, z)) return false;
    this.cells[this.idx(x, y, z)] = t ? cellOf(t, meta) : 0;
    this.dirty = true;
    return true;
  }

  count() {
    let n = 0;
    for (const c of this.cells) if (c) n++;
    return n;
  }

  /** Solid for movement at the cell level: anything that is not air, except
   *  open doors and cells a rift has opened up. Stairs count as solid here;
   *  colliders() has their exact shape. */
  isSolid(x, y, z) {
    const t = this.get(x, y, z);
    if (!t) return false;
    if (t === BLOCK.DOOR && this.doorsOpen) return false;
    if (this.passable && this.passable.has(x + "," + y + "," + z)) return false;
    return true;
  }

  /** The collision boxes of a cell in world units, as [x0,y0,z0,x1,y1,z1]
   *  arrays, or null for air. A full block is one box; a stair is two. */
  colliders(x, y, z) {
    if (!this.isSolid(x, y, z)) return null;
    const c = this.raw(x, y, z);
    const t = typeOf(c);
    const local = isStair(t) ? stairBoxes(metaOf(c)) : SHAPE_BOXES[t];
    if (!local) return [[x, y, z, x + 1, y + 1, z + 1]];
    return local.map((b) => [x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]]);
  }

  /** A button is "pressed" when a player's feet are in the cell above it. */
  buttonsPressedBy(positions) {
    for (const p of positions) {
      const x = Math.floor(p.x), y = Math.floor(p.y - 0.05), z = Math.floor(p.z);
      if (this.get(x, y, z) === BLOCK.BUTTON) return true;
    }
    return false;
  }

  setDoorsOpen(open) {
    if (open === this.doorsOpen) return;
    this.doorsOpen = open;
    const mat = MATERIALS[BLOCK.DOOR];
    if (!mat) return;
    mat.opacity = open ? 0.15 : 1;
    mat.transparent = true;
    mat.depthWrite = !open;
  }

  /** A slow glow on acid and the exit so those two read as live, not paint. */
  animate(timeMs) {
    const acid = MATERIALS[BLOCK.HAZARD];
    if (acid) acid.emissiveIntensity = 0.4 + 0.28 * Math.sin(timeMs * 0.005);
    const goal = MATERIALS[BLOCK.GOAL];
    if (goal) goal.emissiveIntensity = 0.55 + 0.35 * Math.sin(timeMs * 0.003);
  }

  /** Rebuild the instanced meshes when cells changed. Cheap enough to call
   *  every frame; it only does work when `dirty`. One InstancedMesh per
   *  distinct cell byte (type + stair orientation). */
  rebuild() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const k of Object.keys(this.meshes)) {
      this.group.remove(this.meshes[k]);
      this.meshes[k].dispose();
    }
    this.meshes = {};
    const counts = {};
    for (const c of this.cells) if (c) counts[c] = (counts[c] || 0) + 1;
    const m4 = new THREE.Matrix4();
    const rotY = new THREE.Matrix4();
    for (const cStr of Object.keys(counts)) {
      const c = Number(cStr);
      const t = typeOf(c), meta = metaOf(c);
      const info = BLOCK_INFO[t];
      if (!info) continue;
      const mat = materialFor(t, this.doorsOpen);
      const geo = isStair(t) ? stairGeometry(stairFlipped(meta), Boolean(info.nosing)) : blockGeometry(t);
      const mesh = new THREE.InstancedMesh(geo, mat, counts[c]);
      mesh.userData.blockType = t;
      rotY.makeRotationY(isStair(t) ? stairRot(meta) * (Math.PI / 2) : 0);
      let i = 0;
      const [w, h, d] = this.size;
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h; y++)
          for (let z = 0; z < d; z++) {
            if (this.cells[this.idx(x, y, z)] !== c) continue;
            m4.makeTranslation(x + 0.5, y + 0.5, z + 0.5).multiply(rotY);
            mesh.setMatrixAt(i++, m4);
          }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes[c] = mesh;
    }
  }

  /** Voxel raycast (Amanatides & Woo). Returns {x,y,z,t,meta,nx,ny,nz,dist,point}
   *  for the first non-air cell along the ray, or null. Open doors still hit
   *  when `includeOpenDoors` (the editor wants them). Stairs are hit as full
   *  cells; the face normal is the cell face the ray entered through. */
  raycast(origin, dir, maxDist = 64, includeOpenDoors = true) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z);
    const tDeltaX = stepX ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = stepX > 0 ? (x + 1 - origin.x) * tDeltaX : stepX < 0 ? (origin.x - x) * tDeltaX : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - origin.y) * tDeltaY : stepY < 0 ? (origin.y - y) * tDeltaY : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) * tDeltaZ : stepZ < 0 ? (origin.z - z) * tDeltaZ : Infinity;
    let nx = 0, ny = 0, nz = 0, dist = 0;
    for (let i = 0; i < 400; i++) {
      const t = this.get(x, y, z);
      if (t && (includeOpenDoors || t !== BLOCK.DOOR || !this.doorsOpen) && i > 0) {
        const point = new THREE.Vector3(origin.x + dir.x * dist, origin.y + dir.y * dist, origin.z + dir.z * dist);
        return { x, y, z, t, meta: this.meta(x, y, z), nx, ny, nz, dist, point };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; dist = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; dist = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; dist = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (dist > maxDist) return null;
      // Leaving the grid for good?
      if ((x < 0 && stepX <= 0) || (x >= this.size[0] && stepX >= 0)) return null;
      if ((y < 0 && stepY <= 0) || (y >= this.size[1] && stepY >= 0)) return null;
      if ((z < 0 && stepZ <= 0) || (z >= this.size[2] && stepZ >= 0)) return null;
    }
    return null;
  }
}

// ---- stair shapes -----------------------------------------------------------
//
// In cell-local units (0..1). Rotation 0 climbs toward +Z: the low step is at
// the -Z side, the high step at +Z. Other rotations rotate these about the
// cell centre; flipped stairs hang from the ceiling (slab on top).

/** Collision boxes for a stair with this meta, in cell-local units. */
export function stairBoxes(meta) {
  const rot = stairRot(meta), flip = stairFlipped(meta);
  const d = STAIR_DIR[rot];
  // Back half of the cell along the climb direction.
  const bx0 = d.x > 0 ? 0.5 : 0, bx1 = d.x < 0 ? 0.5 : 1;
  const bz0 = d.z > 0 ? 0.5 : 0, bz1 = d.z < 0 ? 0.5 : 1;
  return flip
    ? [[0, 0.5, 0, 1, 1, 1], [bx0, 0, bz0, bx1, 0.5, bz1]]
    : [[0, 0, 0, 1, 0.5, 1], [bx0, 0.5, bz0, bx1, 1, bz1]];
}

let _box = null;
function unitBox() {
  return (_box ||= new THREE.BoxGeometry(1, 1, 1));
}

/** BoxGeometry UVs cover each face 0..1. Scale them so a face of size `s`
 *  shows that fraction of the tile, matching texel density on a full cube. */
function scaleBoxUVs(geo, sx, sy, sz) {
  const uv = geo.attributes.uv;
  const spans = [
    [sz, sy], [sz, sy], // ±x
    [sx, sz], [sx, sz], // ±y
    [sx, sy], [sx, sy], // ±z
  ];
  for (let f = 0; f < 6; f++) {
    const su = spans[f][0], sv = spans[f][1];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
}

function mergeParts(parts) {
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return geo;
}

const _stairGeo = {};
/** Stair geometry for rotation 0, centred on the cell like BoxGeometry.
 *  `nosing` adds a lip on the high step so panel stairs don't share a
 *  profile with plate stairs. The lip is visual; collision stays stairBoxes. */
function stairGeometry(flipped, nosing) {
  const k = (flipped ? "f" : "n") + (nosing ? "l" : "");
  if (_stairGeo[k]) return _stairGeo[k];
  const slab = new THREE.BoxGeometry(1, 0.5, 1);
  const step = new THREE.BoxGeometry(1, 0.5, 0.5);
  scaleBoxUVs(slab, 1, 0.5, 1);
  scaleBoxUVs(step, 1, 0.5, 0.5);
  if (flipped) {
    slab.translate(0, 0.25, 0);
    step.translate(0, -0.25, 0.25);
  } else {
    slab.translate(0, -0.25, 0);
    step.translate(0, 0.25, 0.25);
  }
  const parts = [slab, step];
  if (nosing) {
    const lip = new THREE.BoxGeometry(1, 0.1, 0.12);
    scaleBoxUVs(lip, 1, 0.1, 0.12);
    lip.translate(0, flipped ? -0.45 : 0.45, 0.5);
    parts.push(lip);
  }
  return (_stairGeo[k] = mergeParts(parts));
}

const _shapeGeo = {};
/** Shared mesh for a block type. Stairs are handled by stairGeometry so a
 *  flipped stair can reuse the same material with a different mesh. */
export function blockGeometry(type) {
  const info = BLOCK_INFO[type];
  if (!info) return unitBox();
  if (info.stair) return stairGeometry(false, Boolean(info.nosing));
  if (_shapeGeo[type]) return _shapeGeo[type];
  let geo;
  if (info.shape === "panel") geo = framedCube();
  else if (info.shape === "button") geo = buttonGeometry();
  else if (info.shape === "exit") geo = exitGeometry();
  else if (info.shape === "acid") geo = acidGeometry();
  else if (info.shape === "door") geo = doorGeometry();
  else geo = unitBox();
  return (_shapeGeo[type] = geo);
}

/** Picture-frame cube: posts and rails at the cell boundary, a plate set
 *  back on each face. Plate blocks stay a flat cube, so the two silhouettes
 *  differ even before the textures do. */
function framedCube() {
  const t = 0.16;
  const parts = [];
  const add = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  const o = 0.5 - t / 2;
  for (const x of [-o, o]) for (const z of [-o, o]) add(t, 1, t, x, 0, z);
  const span = 1 - 2 * t;
  for (const y of [-o, o]) {
    add(span, t, t, 0, y, -o);
    add(span, t, t, 0, y, o);
    add(t, t, span, -o, y, 0);
    add(t, t, span, o, y, 0);
  }
  // Tuck the face plates into the frame so the recess has no see-through seam.
  const s = 1 - 2 * t + 0.04;
  const plate = 0.04;
  const p = 0.5 - 0.09;
  add(plate, s, s, p, 0, 0);
  add(plate, s, s, -p, 0, 0);
  add(s, plate, s, 0, p, 0);
  add(s, plate, s, 0, -p, 0);
  add(s, s, plate, 0, 0, p);
  add(s, s, plate, 0, 0, -p);
  return mergeParts(parts);
}

function buttonGeometry() {
  const base = new THREE.BoxGeometry(1, 0.18, 1);
  const nub = new THREE.BoxGeometry(0.46, 0.16, 0.46);
  base.translate(0, -0.5 + 0.09, 0);
  nub.translate(0, -0.5 + 0.18 + 0.08, 0);
  return mergeParts([base, nub]);
}

function exitGeometry() {
  const parts = [];
  const add = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  add(1, 0.12, 1, 0, -0.5 + 0.06, 0);
  add(0.28, 0.86, 0.28, 0, -0.5 + 0.12 + 0.43, 0);
  for (const [x, z] of [[-0.38, -0.38], [0.38, -0.38], [-0.38, 0.38], [0.38, 0.38]]) {
    add(0.12, 0.28, 0.12, x, -0.5 + 0.12 + 0.14, z);
  }
  return mergeParts(parts);
}

function acidGeometry() {
  const body = new THREE.BoxGeometry(0.98, 0.72, 0.98);
  const skin = new THREE.BoxGeometry(1, 0.08, 1);
  body.translate(0, -0.5 + 0.36, 0);
  skin.translate(0, -0.5 + 0.72 + 0.04, 0);
  return mergeParts([body, skin]);
}

/** Full cube plus a belt that stands proud of the cell, so a door isn't
 *  another flat box next to panels and plates. */
function doorGeometry() {
  const body = new THREE.BoxGeometry(1, 1, 1);
  const rail = new THREE.BoxGeometry(1.06, 0.18, 1.06);
  rail.translate(0, 0.02, 0);
  return mergeParts([body, rail]);
}

// Collision in cell-local units. Anything not listed is a full cube. The
// button and exit are short so you walk onto them; acid is a sunken pool.
const SHAPE_BOXES = {
  [BLOCK.BUTTON]: [[0, 0, 0, 1, 0.18, 1], [0.27, 0.18, 0.27, 0.73, 0.34, 0.73]],
  [BLOCK.GOAL]: [[0, 0, 0, 1, 0.12, 1], [0.36, 0.12, 0.36, 0.64, 1, 0.64]],
  [BLOCK.HAZARD]: [[0, 0, 0, 1, 0.8, 1]],
};

const MATERIALS = {};
function materialFor(type, doorsOpen) {
  const info = BLOCK_INFO[type];
  let mat = MATERIALS[type];
  if (!mat) {
    const glass = type === BLOCK.GLASS;
    mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: info.emissive || 0x000000,
      emissiveIntensity: info.emissive ? 0.55 : 0,
      map: info.texture || null,
      transparent: glass || type === BLOCK.DOOR,
      opacity: 1,
      depthWrite: !glass,
    });
    MATERIALS[type] = mat;
  }
  if (type === BLOCK.DOOR) {
    mat.opacity = doorsOpen ? 0.15 : 1;
    mat.transparent = true;
    mat.depthWrite = !doorsOpen;
  }
  return mat;
}

// ---- 16×16 face tiles -------------------------------------------------------
//
// Painted once, shared by every instance. Nearest filtering keeps the pixels
// crisp at the size a block is on screen. `swatch` is the same image for the
// hotbar, so the icon and the world cannot drift apart.

const TILE = 16;

function makeTile(paint) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.createImageData(TILE, TILE);
  const pix = (x, y, hex, a = 255) => {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = (y * TILE + x) * 4;
    img.data[i] = (hex >> 16) & 255;
    img.data[i + 1] = (hex >> 8) & 255;
    img.data[i + 2] = hex & 255;
    img.data[i + 3] = a;
  };
  const fill = (hex, a = 255) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) pix(x, y, hex, a);
  };
  const rect = (x0, y0, x1, y1, hex, a = 255) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pix(x, y, hex, a);
  };
  paint({ pix, fill, rect });
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, swatch: canvas.toDataURL() };
}

function paintPanel({ fill, pix }) {
  fill(0xe4edf6);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    if (((x * 3 + y * 5) & 7) === 0) pix(x, y, 0xd3dfeb);
    if (((x * 5 + y) & 11) === 0) pix(x, y, 0xf7fbfe);
  }
}

function paintPlate({ fill, pix }) {
  fill(0x3c342b);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const d = (x + y) % 8;
    if (d === 0) pix(x, y, 0x7a6a52);
    else if (d === 1 || d === 7) pix(x, y, 0x5a4c3c);
    else if (d === 4) pix(x, y, 0x2a241e);
  }
  const rivet = (x, y) => {
    pix(x, y, 0x16130f);
    pix(x + 1, y, 0xe6d2a8);
    pix(x, y + 1, 0x6b5c48);
    pix(x + 1, y + 1, 0x16130f);
  };
  rivet(2, 2); rivet(12, 2); rivet(2, 12); rivet(12, 12);
  for (let i = 0; i < TILE; i++) {
    pix(i, 0, 0x1a1612); pix(i, 15, 0x1a1612); pix(0, i, 0x1a1612); pix(15, i, 0x1a1612);
  }
}

function bands(pix, edge, core) {
  for (let x = 0; x < TILE; x++) {
    pix(x, 0, edge); pix(x, 1, core);
    pix(x, 14, core); pix(x, 15, edge);
  }
}

const TILE_PAINT = {
  [BLOCK.PANEL]: paintPanel,
  [BLOCK.STEEL]: paintPlate,
  [BLOCK.GLASS]: ({ fill, pix }) => {
    fill(0xd7f3ff, 50);
    for (let i = 0; i < TILE; i++) {
      for (let t = 0; t < 2; t++) {
        pix(i, t, 0xf4fcff, 250);
        pix(i, 15 - t, 0xf4fcff, 250);
        pix(t, i, 0xf4fcff, 250);
        pix(15 - t, i, 0xf4fcff, 250);
      }
    }
    for (let i = 2; i < 14; i++) pix(i, i, 0xffffff, 160);
  },
  [BLOCK.STAIR]: (api) => {
    paintPanel(api);
    bands(api.pix, 0x1d6cb5, 0x8ecfff);
  },
  [BLOCK.STAIR_STEEL]: (api) => {
    paintPlate(api);
    bands(api.pix, 0xc47a14, 0xffd27a);
  },
  [BLOCK.GOAL]: ({ fill, pix }) => {
    fill(0x12824c);
    for (let i = 0; i < TILE; i++) {
      pix(i, 0, 0xd8ffe9); pix(i, 15, 0x0c5a34); pix(0, i, 0x8ef0b8); pix(15, i, 0x0c5a34);
    }
    for (let i = 0; i < 6; i++) {
      pix(7, 3 + i, 0xe9fff3); pix(8, 3 + i, 0xe9fff3);
      pix(7 - i, 8 + i, 0xb8ffd4); pix(8 + i, 8 + i, 0xb8ffd4);
    }
  },
  [BLOCK.HAZARD]: ({ fill, pix }) => {
    fill(0xc6ef1a);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if ((x * 4 + y * 3) % 9 === 0) pix(x, y, 0xf4ff8a);
      if ((x * 2 + y * 5) % 11 === 0) pix(x, y, 0x6ea000);
    }
    const bubble = (cx, cy, r, hex) => {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) pix(x, y, hex);
      }
    };
    bubble(4, 4, 2, 0xf7ffb0);
    bubble(11, 6, 2, 0x8fbf00);
    bubble(7, 12, 2, 0xf7ffb0);
    bubble(13, 13, 1, 0xe8ff70);
    for (let x = 0; x < TILE; x++) {
      pix(x, 0, 0xf8ffc4);
      pix(x, 1, 0xe4ff6a);
    }
  },
  [BLOCK.BUTTON]: ({ fill, pix }) => {
    fill(0xb42323);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const dx = x - 7.5, dy = y - 7.5, d = dx * dx + dy * dy;
      if (d < 22) pix(x, y, 0xff4d4d);
      if (d < 8) pix(x, y, 0xffd2d2);
    }
    for (let i = 0; i < TILE; i++) {
      pix(i, 0, 0x6e1010); pix(i, 15, 0x6e1010); pix(0, i, 0x6e1010); pix(15, i, 0x6e1010);
    }
  },
  [BLOCK.DOOR]: ({ fill, pix, rect }) => {
    fill(0x3564c0);
    for (let x = 0; x < TILE; x += 4) for (let y = 0; y < TILE; y++) pix(x, y, 0x24498f);
    rect(1, 7, 14, 9, 0xd7e6ff);
    for (let x = 1; x < 15; x++) pix(x, 8, 0x8eaddd);
    rect(5, 2, 10, 5, 0xc5e4ff);
    pix(12, 8, 0xf0d48a); pix(12, 9, 0xc49a45); pix(13, 8, 0xf0d48a);
    for (let i = 0; i < TILE; i++) {
      pix(i, 0, 0x162848); pix(i, 15, 0x162848); pix(0, i, 0x162848); pix(15, i, 0x162848);
    }
  },
};

for (const type of Object.keys(TILE_PAINT)) {
  const made = makeTile(TILE_PAINT[type]);
  BLOCK_INFO[type].type = Number(type);
  BLOCK_INFO[type].texture = made.texture;
  BLOCK_INFO[type].swatch = made.swatch;
}

// ---- built-in maps ----------------------------------------------------------

/** A small teaching map: a floor, a wall you cannot rift onto, a wall you
 *  can, a gap, a button and door, a stair run, and an exit on a ledge. Also
 *  the template for "New map". */
export function starterMap() {
  const size = [24, 10, 24];
  const grid = new Map();
  const put = (x, y, z, t, m = 0) => grid.set(`${x},${y},${z}`, m ? [x, y, z, t, m] : [x, y, z, t]);
  // Floor plate with a few dark tiles.
  for (let x = 0; x < 24; x++) for (let z = 0; z < 24; z++) put(x, 0, z, (x + z) % 7 === 0 ? BLOCK.STEEL : BLOCK.PANEL);
  // A trench of acid across the middle: you need a rift to cross it.
  for (let x = 1; x < 24; x++) for (let z = 10; z < 13; z++) put(x, 0, z, BLOCK.HAZARD);
  // Back wall of light panels: a riftable target on the far side.
  for (let x = 0; x < 24; x++) for (let y = 1; y < 7; y++) put(x, y, 23, BLOCK.PANEL);
  // Left wall, dark: rifts bounce off it.
  for (let z = 0; z < 24; z++) for (let y = 1; y < 5; y++) put(0, y, z, BLOCK.STEEL);
  // A glass divider on the far side with a door through it.
  for (let z = 13; z < 23; z++) for (let y = 1; y < 4; y++) put(10, y, z, BLOCK.GLASS);
  for (let y = 1; y < 4; y++) put(10, y, 16, BLOCK.DOOR);
  // Two buttons: one holds the door for a friend, one is reachable solo.
  put(3, 1, 20, BLOCK.BUTTON);
  put(14, 1, 3, BLOCK.BUTTON);
  // A stair run on the near side, climbing toward +X: a riftable slope. Two
  // steps and a landing; aim a rift at the slope and drop in from above.
  for (let z = 2; z < 6; z++) {
    put(18, 1, z, BLOCK.STAIR, 1);
    put(19, 1, z, BLOCK.PANEL);
    put(19, 2, z, BLOCK.STAIR, 1);
    put(20, 1, z, BLOCK.PANEL);
    put(20, 2, z, BLOCK.PANEL);
    put(21, 1, z, BLOCK.PANEL);
    put(21, 2, z, BLOCK.PANEL);
  }
  // Plate stairs just beside that run: same climb, amber tread, no rifts.
  for (let z = 6; z < 9; z++) {
    put(18, 1, z, BLOCK.STAIR_STEEL, 1);
    put(19, 1, z, BLOCK.STEEL);
    put(19, 2, z, BLOCK.STAIR_STEEL, 1);
  }
  // A ledge with the exit, reachable only through a rift (or a friend's).
  for (let x = 16; x < 22; x++) for (let z = 17; z < 22; z++) put(x, 4, z, BLOCK.PANEL);
  for (let x = 16; x < 22; x++) put(x, 5, 21, BLOCK.PANEL);
  put(19, 5, 19, BLOCK.GOAL);
  return { schema: 1, size, spawn: [4, 1, 4, Math.PI * 0.75], blocks: [...grid.values()] };
}

/** The empty template for a new map: a 16x16 panel floor. */
export function blankMap() {
  const blocks = [];
  for (let x = 4; x < 20; x++) for (let z = 4; z < 20; z++) blocks.push([x, 0, z, BLOCK.PANEL]);
  return { schema: 1, size: [24, 12, 24], spawn: [12, 1, 12, 0], blocks };
}

/** A short solo course that puts every block on the route.
 *
 *  1. Pit room. Floor and the right wall are plate. The left wall and the
 *     far wall are panel. Acid fills the pit, so the crossing is a rift
 *     from the light wall to the light wall.
 *  2. Two stair runs. Panel stairs (blue nosing) face the gap; the light
 *     run of the upper left wall takes the other rift, and the slope rift
 *     opens there at standing height. Plate stairs (amber) dead-end.
 *  3. Upper floor. A glass window shows the exit and a side pool of acid.
 *     The floor and walls are plate, so the only way through is the door,
 *     and the button pad is the tile in front of it.
 *  4. The exit beacon is the green pad past the door.
 *
 *  Open with ?map=example. A couple of minutes, one player. */
export function exampleMap() {
  const W = 16, H = 10, D = 36;
  const grid = new Map();
  const put = (x, y, z, t, m = 0) => {
    grid.set(`${x},${y},${z}`, m ? [x, y, z, t, m] : [x, y, z, t]);
  };
  const fill = (x0, x1, y0, y1, z0, z1, t, m = 0) => {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) put(x, y, z, t, m);
  };
  const stairRun = (x0, x1, y, z, type) => {
    for (let x = x0; x <= x1; x++) {
      put(x, y, z, type, 0); // climbs toward +Z
      put(x, y, z + 1, BLOCK.STEEL); // under the upper step; not a rift target
      put(x, y + 1, z + 1, type, 0);
    }
  };

  // Shell: plate floor, plate walls, open sky. Features overwrite this.
  fill(0, W - 1, 0, 0, 0, D - 1, BLOCK.STEEL);
  fill(0, W - 1, 1, 7, 0, 0, BLOCK.STEEL);
  fill(0, W - 1, 1, 7, D - 1, D - 1, BLOCK.STEEL);
  fill(0, 0, 1, 7, 0, D - 1, BLOCK.STEEL);
  fill(W - 1, W - 1, 1, 7, 0, D - 1, BLOCK.STEEL);

  // --- pit room (stand on plate, shoot panels, don't touch the acid) ---
  fill(0, 0, 1, 5, 1, 11, BLOCK.PANEL); // left wall, the near rift
  fill(1, 14, 1, 5, 12, 12, BLOCK.STEEL);
  fill(2, 5, 1, 4, 12, 12, BLOCK.PANEL);
  fill(10, 13, 1, 4, 12, 12, BLOCK.PANEL);
  for (let y = 1; y <= 3; y++) for (let x = 7; x <= 8; x++) grid.delete(`${x},${y},12`);
  fill(1, 14, 0, 0, 7, 9, BLOCK.HAZARD);

  // --- stairs, then a sealed acid gap, then the upper floor ---
  stairRun(2, 5, 1, 16, BLOCK.STAIR);
  stairRun(10, 13, 1, 16, BLOCK.STAIR_STEEL);
  fill(10, 13, 1, 3, 18, 18, BLOCK.STEEL); // plate-stair dead end
  fill(1, 14, 0, 0, 18, 20, BLOCK.HAZARD);
  fill(1, 14, 4, 4, 21, 34, BLOCK.STEEL); // upper floor, not riftable; runs into the end wall
  fill(1, 14, 1, 3, 21, 21, BLOCK.STEEL); // closes the crawlspace under the lip
  // Left-wall panel on the upper floor: the slope rift opens here, at
  // standing height, so the landing is a step rather than a fall. The
  // stretch stops before the door, and the right wall stays plate.
  fill(0, 0, 5, 7, 23, 28, BLOCK.PANEL);

  // --- glass, button, door, acid beside the exit ---
  fill(1, 14, 5, 8, 30, 30, BLOCK.STEEL);
  fill(3, 9, 5, 7, 30, 30, BLOCK.GLASS);
  // Three blocks tall: standing on the button raises you, and a lintel at
  // head height would stop you in the threshold.
  fill(11, 12, 5, 7, 30, 30, BLOCK.DOOR);
  fill(11, 12, 5, 5, 28, 29, BLOCK.BUTTON);
  fill(3, 5, 4, 4, 32, 33, BLOCK.HAZARD);
  // Straight through the door, so the beacon is the thing in front of you.
  put(11, 5, 33, BLOCK.GOAL);

  return { schema: 1, size: [W, H, D], spawn: [5, 1, 4, -0.45], blocks: [...grid.values()] };
}

const BUILTIN_IDS = new Set(["starter", "example"]);

export function isBuiltinMap(id) {
  return BUILTIN_IDS.has(id);
}

/** Built-in maps the client serves without the API. `null` for anything else. */
export function builtinMap(id) {
  if (id === "starter") {
    return {
      id,
      name: "Starter yard",
      description: "The built-in teaching map. Save a copy to make it yours.",
      data: starterMap(),
    };
  }
  if (id === "example") {
    return {
      id,
      name: "Example course",
      description: "A short solo course: panels and plates, a slope rift, glass, a button and door, acid, and the exit.",
      data: exampleMap(),
    };
  }
  return null;
}
