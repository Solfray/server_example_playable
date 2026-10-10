// editor.js: build mode. Fly around, place and remove blocks, set the spawn.
//
// Editing is local and single-author: only the map's owner (or the author of
// an unsaved new map) can enter build mode, and the result is saved through
// the API (api.js) under their verified identity. Other players in the room
// get an event telling them the map changed and reload it (app.js).

import * as THREE from "three";
import { BLOCK, BLOCK_INFO } from "./world.js";
import { PLAYER } from "./player.js";

export class Editor {
  constructor(world, player, scene) {
    this.world = world;
    this.player = player;
    this.active = false;
    this.type = BLOCK.PANEL;
    this.tool = "block"; // "block" | "spawn"
    this.cursor = new THREE.Mesh(
      new THREE.BoxGeometry(1.02, 1.02, 1.02),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.8 })
    );
    this.cursor.visible = false;
    scene.add(this.cursor);
    this.spawnMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 0.6, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe066, wireframe: true })
    );
    this.spawnMarker.visible = false;
    scene.add(this.spawnMarker);
    this.target = null; // {place: [x,y,z], remove: [x,y,z]}
  }

  setActive(on) {
    this.active = on;
    this.player.flying = on;
    this.cursor.visible = false;
    this.spawnMarker.visible = on;
    if (on) this.player.vel.set(0, 0, 0);
  }

  select(t) {
    if (BLOCK_INFO[t]) {
      this.type = t;
      this.tool = "block";
    }
  }

  cycle(dir) {
    const types = Object.keys(BLOCK_INFO).map(Number);
    const i = types.indexOf(this.type);
    this.select(types[(i + dir + types.length) % types.length]);
  }

  /** Every frame while active: find the cell under the crosshair. */
  update() {
    if (!this.active) return;
    const s = this.world.spawn;
    this.spawnMarker.position.set(s[0] + 0.5, s[1] + 0.3, s[2] + 0.5);
    this.spawnMarker.rotation.y += 0.02;
    const hit = this.world.raycast(this.player.eye(), this.player.forward(), 24, true);
    if (!hit) {
      // Nothing hit: offer the cell 4 units ahead so you can build in the air.
      const p = this.player.eye().addScaledVector(this.player.forward(), 4);
      const cell = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
      this.target = this.world.inBounds(...cell) ? { place: cell, remove: null } : null;
    } else {
      this.target = { place: [hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz], remove: [hit.x, hit.y, hit.z] };
    }
    if (this.target && this.tool === "block") {
      this.cursor.visible = true;
      this.cursor.position.set(this.target.place[0] + 0.5, this.target.place[1] + 0.5, this.target.place[2] + 0.5);
      this.cursor.material.color.set(this.world.inBounds(...this.target.place) ? 0xffffff : 0xff4040);
    } else this.cursor.visible = false;
  }

  /** Left click. Returns true when the map changed. */
  primary() {
    if (!this.active || !this.target) return false;
    if (this.tool === "spawn") return this.setSpawn();
    const [x, y, z] = this.target.place;
    if (!this.world.inBounds(x, y, z) || this.world.get(x, y, z)) return false;
    return this.world.set(x, y, z, this.type);
  }

  /** Right click. Returns true when the map changed. */
  secondary() {
    if (!this.active || !this.target || !this.target.remove) return false;
    const [x, y, z] = this.target.remove;
    return this.world.set(x, y, z, 0);
  }

  /** Put the spawn where I am standing (or hovering), facing where I look. */
  setSpawn() {
    const p = this.player.pos;
    const cell = [Math.floor(p.x), Math.max(0, Math.floor(p.y)), Math.floor(p.z)];
    if (!this.world.inBounds(...cell)) return false;
    this.world.spawn = [cell[0], cell[1], cell[2], Math.round(this.player.yaw * 100) / 100];
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

  paletteHtml() {
    return Object.entries(BLOCK_INFO)
      .map(([t, info]) => {
        const sel = Number(t) === this.type && this.tool === "block" ? " sel" : "";
        return `<button class="pal${sel}" data-type="${t}" title="${info.hint}"><span class="sw" style="background:#${info.color.toString(16).padStart(6, "0")}"></span>${t}. ${info.name}</button>`;
      })
      .join("") + `<button class="pal${this.tool === "spawn" ? " sel" : ""}" data-type="spawn" title="set the spawn point where you stand"><span class="sw" style="background:#ffe066"></span>0. Spawn</button>`;
  }
}

export { PLAYER };
