// world.js: the map as a voxel grid, its Three.js meshes, and the starter map.
//
// A map is a grid of 1-unit cells (see src/api/maps.ts for the JSON shape the
// server validates). This module knows nothing about networking or Solfray:
// it turns map JSON into geometry and answers "is this cell solid?".

import * as THREE from "three";

export const BLOCK = { PANEL: 1, STEEL: 2, GOAL: 3, HAZARD: 4, BUTTON: 5, DOOR: 6, GLASS: 7 };

export const BLOCK_INFO = {
  [BLOCK.PANEL]: { name: "Panel", hint: "light panel: rifts stick to it", color: 0xe4e6ea, riftable: true },
  [BLOCK.STEEL]: { name: "Plate", hint: "dark plate: rifts bounce off", color: 0x3b4149, riftable: false },
  [BLOCK.GOAL]: { name: "Exit", hint: "exit pad: touch it to finish", color: 0x35d07f, riftable: false, emissive: 0x1d8a52 },
  [BLOCK.HAZARD]: { name: "Acid", hint: "acid: touching it sends you back to spawn", color: 0xc9ff3a, riftable: false, emissive: 0x6a8f00, opacity: 0.85 },
  [BLOCK.BUTTON]: { name: "Button", hint: "floor button: stand on it to open every door", color: 0xd94b4b, riftable: false, emissive: 0x4d0f0f },
  [BLOCK.DOOR]: { name: "Door", hint: "door: solid until a button is held down", color: 0x4b7bd9, riftable: false, opacity: 1 },
  [BLOCK.GLASS]: { name: "Glass", hint: "glass: see-through, solid, not riftable", color: 0x9fd8ff, riftable: false, opacity: 0.28 },
};

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
    for (const [x, y, z, t] of data.blocks) this.cells[this.idx(x, y, z)] = t;
    this.spawn = data.spawn.slice();
    this.dirty = true;
  }

  toJSON() {
    const blocks = [];
    const [w, h, d] = this.size;
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++)
        for (let z = 0; z < d; z++) {
          const t = this.cells[this.idx(x, y, z)];
          if (t) blocks.push([x, y, z, t]);
        }
    return { schema: 1, size: this.size.slice(), spawn: this.spawn.map((v) => Math.round(v * 100) / 100), blocks };
  }

  idx(x, y, z) {
    return (x * this.size[1] + y) * this.size[2] + z;
  }

  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2];
  }

  get(x, y, z) {
    return this.inBounds(x, y, z) ? this.cells[this.idx(x, y, z)] : 0;
  }

  set(x, y, z, t) {
    if (!this.inBounds(x, y, z)) return false;
    this.cells[this.idx(x, y, z)] = t;
    this.dirty = true;
    return true;
  }

  count() {
    let n = 0;
    for (const c of this.cells) if (c) n++;
    return n;
  }

  /** Solid for movement. Open doors are not solid; everything else that is
   *  not air is. */
  isSolid(x, y, z) {
    const t = this.get(x, y, z);
    if (!t) return false;
    if (t === BLOCK.DOOR && this.doorsOpen) return false;
    if (this.passable && this.passable.has(x + "," + y + "," + z)) return false;
    return true;
  }

  /** The cells a block of this type occupies for a standing player: a button
   *  is "pressed" when a player's feet are in the cell above it. */
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
    const m = this.meshes[BLOCK.DOOR];
    if (m) {
      m.material.opacity = open ? 0.12 : 1;
      m.material.transparent = true;
      m.material.depthWrite = !open;
    }
  }

  /** Rebuild the instanced meshes when cells changed. Cheap enough to call
   *  every frame; it only does work when `dirty`. */
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
    const box = new THREE.BoxGeometry(1, 1, 1);
    const m4 = new THREE.Matrix4();
    for (const tStr of Object.keys(counts)) {
      const t = Number(tStr);
      const info = BLOCK_INFO[t];
      const mat = new THREE.MeshLambertMaterial({
        color: info.color,
        emissive: info.emissive || 0x000000,
        transparent: info.opacity !== undefined && info.opacity < 1,
        opacity: info.opacity === undefined ? 1 : info.opacity,
      });
      if (t === BLOCK.DOOR) {
        mat.transparent = true;
        mat.opacity = this.doorsOpen ? 0.12 : 1;
        mat.depthWrite = !this.doorsOpen;
      }
      const mesh = new THREE.InstancedMesh(box, mat, counts[t]);
      mesh.userData.blockType = t;
      let i = 0;
      const [w, h, d] = this.size;
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h; y++)
          for (let z = 0; z < d; z++) {
            if (this.cells[this.idx(x, y, z)] !== t) continue;
            m4.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
            mesh.setMatrixAt(i++, m4);
          }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes[t] = mesh;
    }
  }

  /** Voxel raycast (Amanatides & Woo). Returns {x,y,z,t,nx,ny,nz,dist,point}
   *  for the first non-air cell along the ray, or null. Open doors still hit
   *  when `includeOpenDoors` (the editor wants them). */
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
        return { x, y, z, t, nx, ny, nz, dist, point };
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

/** A small teaching map: a floor, a wall you cannot rift onto, a wall you
 *  can, a gap, a button and door, and an exit on a ledge. Also the template
 *  for "New map". */
export function starterMap() {
  const size = [24, 10, 24];
  const grid = new Map();
  const put = (x, y, z, t) => grid.set(`${x},${y},${z}`, [x, y, z, t]);
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
