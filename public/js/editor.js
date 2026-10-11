// editor.js: build mode, with the controls of a creative mode in a block game.
//
//   left click     break the block you look at
//   right click    place the selected block against the face you look at
//   middle click   pick the block you look at into the hotbar
//   1-9            hotbar slots (every block type fits; no inventory screen)
//   0              the spawn tool: right click sets the spawn on a block
//   wheel          scroll the hotbar
//   F              cycle the placement shape: single block, 3x3 floor,
//                  3x3 north-south wall, 3x3 east-west wall, 6-tall pillar
//   hold right     keep placing every 0.2 s (walk backward to lay a bridge)
//   double Space   toggle flight (Space up, Shift down), Ctrl to fly fast
//
// Stairs orient themselves as you place them: the high step ends up on the
// side you are facing, and placing one against the underside of a block (or
// the upper half of a side face) hangs it upside down.
//
// A translucent ghost shows exactly which cells the next right click fills.
// Stairs always place one at a time (the bulk shapes skip them).
//
// Editing is local and single-author: only the map's owner (or the author of
// an unsaved new map) can enter build mode, and the result is saved through
// the API (api.js) under their verified identity. Other players in the room
// get an event telling them the map changed and reload it (app.js).

import * as THREE from "three";
import { BLOCK_INFO, HOTBAR, isStair, rotFromHeading } from "./world.js";
import { PLAYER } from "./player.js";

export const SLOTS = [...HOTBAR, "spawn"]; // keys 1..9 then 0

/** Placement shapes, cycled with F. Offsets are [x, y, z] from the cell the
 *  click targets; `y` is mirrored downward when placing against a ceiling.
 *  North is -Z and east is +X, as in other block games. */
const span = (f) => [-1, 0, 1].flatMap((a) => [0, 1, 2].map((b) => f(a, b)));
export const SHAPES = [
  { name: "Single block", cells: [[0, 0, 0]] },
  { name: "3x3 floor", cells: [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((z) => [x, 0, z])) },
  { name: "3x3 wall, north-south", cells: span((z, y) => [0, y, z]) },
  { name: "3x3 wall, east-west", cells: span((x, y) => [x, y, 0]) },
  { name: "Pillar, 6 tall", cells: [0, 1, 2, 3, 4, 5].map((y) => [0, y, 0]) },
];
const MAX_CELLS = Math.max(...SHAPES.map((s) => s.cells.length));

export class Editor {
  constructor(world, player, scene) {
    this.world = world;
    this.player = player;
    this.active = false;
    this.slot = 0;
    this.cursor = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 })
    );
    this.cursor.visible = false;
    scene.add(this.cursor);
    this.spawnMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 0.6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe066, wireframe: true })
    );
    this.spawnMarker.visible = false;
    scene.add(this.spawnMarker);
    this.target = null; // { hit, place: [x,y,z], remove: [x,y,z], cells: [[x,y,z]...] }
    this.shape = 0;
    // The placement ghost: one translucent cube per cell the click would fill.
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false });
    const ghostGeo = new THREE.BoxGeometry(1.004, 1.004, 1.004);
    this.ghosts = Array.from({ length: MAX_CELLS }, () => {
      const m = new THREE.Mesh(ghostGeo, this.ghostMat);
      m.visible = false;
      scene.add(m);
      return m;
    });
  }

  get type() {
    const s = SLOTS[this.slot];
    return typeof s === "number" ? s : 0;
  }
  get tool() {
    return SLOTS[this.slot] === "spawn" ? "spawn" : "block";
  }
  get info() {
    return BLOCK_INFO[this.type] || null;
  }

  setActive(on) {
    this.active = on;
    this.player.setMode(on ? "creative" : "survival");
    this.cursor.visible = false;
    this.showGhost([]);
    this.spawnMarker.visible = on;
    if (on) this.player.vel.set(0, 0, 0);
  }

  /** Select a hotbar slot by index (0-based) or by the digit key 1..9, 0. */
  selectSlot(i) {
    this.slot = ((i % SLOTS.length) + SLOTS.length) % SLOTS.length;
  }
  selectDigit(d) {
    this.selectSlot(d === 0 ? SLOTS.length - 1 : d - 1);
  }
  selectType(t) {
    const i = SLOTS.indexOf(t);
    if (i >= 0) this.selectSlot(i);
  }
  cycle(dir) {
    this.selectSlot(this.slot + dir);
  }
  cycleShape(dir = 1) {
    this.shape = (this.shape + dir + SHAPES.length) % SHAPES.length;
  }
  /** The shape in effect: stairs and the spawn tool always use one cell. */
  get effectiveShape() {
    return this.tool === "block" && !isStair(this.type) ? SHAPES[this.shape] : SHAPES[0];
  }

  /** Every frame while active: find the block under the crosshair. */
  update() {
    if (!this.active) return;
    const s = this.world.spawn;
    this.spawnMarker.position.set(s[0] + 0.5, s[1] + 0.3, s[2] + 0.5);
    this.spawnMarker.rotation.y += 0.02;
    const hit = this.world.raycast(this.player.eye(), this.player.forward(), PLAYER.reach, true);
    if (!hit) {
      this.target = null;
      this.cursor.visible = false;
      this.showGhost([]);
      return;
    }
    const place = [hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz];
    this.target = { hit, place, remove: [hit.x, hit.y, hit.z] };
    this.target.cells = this.tool === "block" ? this.placeableCells(place, hit) : [];
    this.cursor.visible = true;
    this.cursor.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.showGhost(this.target.cells);
  }

  /** The cells the selected shape would fill from `place`, minus any that
   *  are out of bounds, already taken, or inside the player. */
  placeableCells(place, hit) {
    const down = hit.ny < 0 ? -1 : 1; // against a ceiling, walls and pillars hang down
    return this.effectiveShape.cells
      .map(([dx, dy, dz]) => [place[0] + dx, place[1] + dy * down, place[2] + dz])
      .filter(([x, y, z]) => this.world.inBounds(x, y, z) && !this.world.get(x, y, z) && !this.insidePlayer(x, y, z));
  }

  insidePlayer(x, y, z) {
    const p = this.player.pos, r = PLAYER.radius;
    return x + 1 > p.x - r && x < p.x + r && z + 1 > p.z - r && z < p.z + r && y + 1 > p.y && y < p.y + this.player.bodyHeight;
  }

  showGhost(cells) {
    const info = this.info;
    if (info) this.ghostMat.color.set(info.color);
    this.ghosts.forEach((m, i) => {
      m.visible = i < cells.length;
      if (m.visible) m.position.set(cells[i][0] + 0.5, cells[i][1] + 0.5, cells[i][2] + 0.5);
    });
  }

  /** Fell far below the build: put the player on top of the nearest column
   *  of blocks (nearest in plan view). Returns true when it moved them. */
  rescueIfFallen() {
    const p = this.player.pos;
    if (p.y > -60) return false; // no block is lower than y = 0
    const [w, h, d] = this.world.size;
    let lowest = Infinity, best = null, bestDist = Infinity;
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++) {
        let top = -1;
        for (let y = 0; y < h; y++)
          if (this.world.get(x, y, z)) {
            top = y;
            if (y < lowest) lowest = y;
          }
        if (top < 0) continue;
        const dist = (x + 0.5 - p.x) ** 2 + (z + 0.5 - p.z) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = [x, top, z];
        }
      }
    if (!best) {
      this.player.respawn(this.world); // an empty map: back to the spawn
      return true;
    }
    if (p.y > lowest - 60) return false;
    this.player.pos.set(best[0] + 0.5, best[1] + 1, best[2] + 0.5);
    this.player.vel.set(0, 0, 0);
    this.player.flying = false;
    return true;
  }

  /** Left click: break. Returns true when the map changed. */
  breakBlock() {
    if (!this.active || !this.target) return false;
    const [x, y, z] = this.target.remove;
    return this.world.set(x, y, z, 0);
  }

  /** Right click: place the selected block (or set the spawn). */
  placeBlock() {
    if (!this.active || !this.target) return false;
    if (this.tool === "spawn") return this.setSpawn();
    // placeableCells already skips taken cells and never builds inside you.
    const cells = this.placeableCells(this.target.place, this.target.hit);
    if (!cells.length) return false;
    const t = this.type;
    const meta = isStair(t) ? this.stairMeta(this.target.hit) : 0;
    for (const [x, y, z] of cells) this.world.set(x, y, z, t, meta);
    return true;
  }

  /** Middle click: pick the block you look at into the hotbar. */
  pickBlock() {
    if (!this.active || !this.target) return;
    this.selectType(this.target.hit.t);
  }

  /** Stair orientation from how the player looks and where they clicked. */
  stairMeta(hit) {
    const f = this.player.forward();
    const rot = rotFromHeading(f.x, f.z);
    let flip = false;
    if (hit.ny < 0) flip = true; // placed against a ceiling
    else if (hit.ny === 0) flip = hit.point.y - hit.y > 0.5; // upper half of a side face
    return rot | (flip ? 4 : 0);
  }

  /** Spawn on top of the block you look at, facing the way you look. */
  setSpawn() {
    const [x, y, z] = this.target.place;
    if (!this.world.inBounds(x, y, z)) return false;
    this.world.spawn = [x, y, z, Math.round(this.player.yaw * 100) / 100];
    this.world.dirty = true;
    return true;
  }

  /** Grow the map one row on an axis end (keeps everything in place). */
  resize(size) {
    const data = this.world.toJSON();
    const [w, h, d] = size;
    data.size = [w, h, d];
    data.blocks = data.blocks.filter(([x, y, z]) => x < w && y < h && z < d);
    data.spawn[0] = Math.min(data.spawn[0], w - 1);
    data.spawn[1] = Math.min(data.spawn[1], h - 1);
    data.spawn[2] = Math.min(data.spawn[2], d - 1);
    this.world.load(data);
  }

  /** The hotbar: nine block slots and the spawn tool, like a quick bar. */
  hotbarHtml() {
    return SLOTS.map((s, i) => {
      const key = i === SLOTS.length - 1 ? 0 : i + 1;
      const sel = i === this.slot ? " sel" : "";
      if (s === "spawn") return `<button class="slot${sel}" data-slot="${i}" title="Spawn tool: right click a block to put the spawn on it"><span class="sw spawn"></span><span class="key">${key}</span></button>`;
      const info = BLOCK_INFO[s];
      const stair = info.stair ? " stair" : "";
      return `<button class="slot${sel}" data-slot="${i}" title="${info.name}: ${info.hint}"><span class="sw${stair}" style="background:#${info.color.toString(16).padStart(6, "0")}"></span><span class="key">${key}</span></button>`;
    }).join("");
  }

  /** The name shown above the hotbar for the selected slot. */
  slotLabel() {
    if (this.tool === "spawn") return "Spawn tool";
    if (!this.info) return "";
    const shape = SHAPES[this.shape];
    if (this.shape === 0) return this.info.name;
    return isStair(this.type) ? `${this.info.name} · single (stairs skip ${shape.name})` : `${this.info.name} · ${shape.name}`;
  }
}

export { PLAYER };
