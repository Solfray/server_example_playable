// world.js: the map as a voxel grid, its Three.js meshes, and the starter map.
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

// TEXTURES (backburner): each entry has a `texture` slot. When textures land,
// a 16x16 image per type goes here (or a URL the map author picks), the
// material gets `map` set to it with NearestFilter, and the stair geometry's
// UVs are already laid out per face so the same image wraps a stair the way
// it wraps a cube. Nothing else needs to change.
export const BLOCK_INFO = {
  [BLOCK.PANEL]: { name: "Panel", hint: "light panel: rifts stick to it", color: 0xe4e6ea, riftable: true, texture: null },
  [BLOCK.STEEL]: { name: "Plate", hint: "dark plate: rifts bounce off", color: 0x3b4149, riftable: false, texture: null },
  [BLOCK.GLASS]: { name: "Glass", hint: "glass: see-through, solid, not riftable", color: 0x9fd8ff, riftable: false, opacity: 0.28, texture: null },
  [BLOCK.STAIR]: { name: "Panel stairs", hint: "panel stairs: walkable slope, rifts stick to a two-step run", color: 0xd3d6dc, riftable: true, stair: true, texture: null },
  [BLOCK.STAIR_STEEL]: { name: "Plate stairs", hint: "plate stairs: walkable slope, rifts bounce off", color: 0x343a42, riftable: false, stair: true, texture: null },
  [BLOCK.GOAL]: { name: "Exit", hint: "exit pad: touch it to finish", color: 0x35d07f, riftable: false, emissive: 0x1d8a52, texture: null },
  [BLOCK.HAZARD]: { name: "Acid", hint: "acid: touching it sends you back to spawn", color: 0xc9ff3a, riftable: false, emissive: 0x6a8f00, opacity: 0.85, texture: null },
  [BLOCK.BUTTON]: { name: "Button", hint: "floor button: stand on it to open every door", color: 0xd94b4b, riftable: false, emissive: 0x4d0f0f, texture: null },
  [BLOCK.DOOR]: { name: "Door", hint: "door: solid until a button is held down", color: 0x4b7bd9, riftable: false, opacity: 1, texture: null },
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
    if (!isStair(t)) return [[x, y, z, x + 1, y + 1, z + 1]];
    return stairBoxes(metaOf(c)).map((b) => [x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]]);
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
    const m = this.meshes[cellOf(BLOCK.DOOR)];
    if (m) {
      m.material.opacity = open ? 0.12 : 1;
      m.material.transparent = true;
      m.material.depthWrite = !open;
    }
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
      const mat = new THREE.MeshLambertMaterial({
        color: info.color,
        emissive: info.emissive || 0x000000,
        transparent: info.opacity !== undefined && info.opacity < 1,
        opacity: info.opacity === undefined ? 1 : info.opacity,
        map: info.texture || null, // TEXTURES: drop a THREE.Texture in BLOCK_INFO[t].texture
      });
      if (t === BLOCK.DOOR) {
        mat.transparent = true;
        mat.opacity = this.doorsOpen ? 0.12 : 1;
        mat.depthWrite = !this.doorsOpen;
      }
      const geo = isStair(t) ? stairGeometry(stairFlipped(meta)) : unitBox();
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

const _stairGeo = {};
/** Stair geometry for rotation 0, centred on the cell like BoxGeometry. */
function stairGeometry(flipped) {
  const k = flipped ? "f" : "n";
  if (_stairGeo[k]) return _stairGeo[k];
  const slab = new THREE.BoxGeometry(1, 0.5, 1);
  const step = new THREE.BoxGeometry(1, 0.5, 0.5);
  if (flipped) {
    slab.translate(0, 0.25, 0);
    step.translate(0, -0.25, 0.25);
  } else {
    slab.translate(0, -0.25, 0);
    step.translate(0, 0.25, 0.25);
  }
  // TEXTURES: the step box's UVs are those of a half-height box, so a 16x16
  // tile is squashed on its small faces. Remap to the matching slice of the
  // tile (the way stair models do) when textures are wired up.
  const geo = mergeGeometries([slab, step], false);
  slab.dispose();
  step.dispose();
  return (_stairGeo[k] = geo);
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
