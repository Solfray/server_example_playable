// avatars.js: the other players, drawn from interpolated poses.
//
// SOLFRAY TIE-IN (guide 4c, rule 2): remote players come from net.poseOf(pk),
// never snapped to the raw frames. Each participant's `color` is the one
// Solfray derives from their key (Solfray.colorOf), so a friend is the same
// colour here as in every other playable, and `display` is the name the chat
// shows them under. Players whose pose is older than a few seconds fade out.

import * as THREE from "three";
import { PLAYER } from "./player.js";

export class Avatars {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.byPk = new Map();
  }

  ensure(p) {
    let a = this.byPk.get(p.pk);
    if (a) return a;
    const color = new THREE.Color(p.color || "#888888");
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.height - PLAYER.radius * 2, 4, 12),
      new THREE.MeshLambertMaterial({ color })
    );
    body.position.y = PLAYER.height / 2;
    g.add(body);
    // A visor so you can tell which way they face.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.1), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    visor.position.set(0, PLAYER.eye, PLAYER.radius);
    g.add(visor);
    const label = makeLabel(p.display || p.pk.slice(0, 6), p.color || "#888888");
    label.position.y = PLAYER.height + 0.35;
    g.add(label);
    a = { group: g, body, visor, label };
    this.byPk.set(p.pk, a);
    this.group.add(g);
    return a;
  }

  rename(p) {
    const a = this.byPk.get(p.pk);
    if (!a) return;
    a.group.remove(a.label);
    a.label = makeLabel(p.display || p.pk.slice(0, 6), p.color || "#888888");
    a.label.position.y = PLAYER.height + 0.35;
    a.group.add(a.label);
  }

  remove(pk) {
    const a = this.byPk.get(pk);
    if (!a) return;
    this.group.remove(a.group);
    this.byPk.delete(pk);
  }

  /** Called every frame. */
  update(net) {
    const seen = new Set();
    for (const p of net.participants) {
      if (!net.me || p.pk === net.me.pk) continue;
      seen.add(p.pk);
      const pose = net.poseOf(p.pk);
      const age = net.poseAge(p.pk);
      const a = this.ensure(p);
      if (!pose || age > 4000) {
        a.group.visible = false;
        continue;
      }
      a.group.visible = true;
      a.group.position.set(pose.x, pose.y, pose.z);
      a.group.rotation.y = pose.yaw || 0;
      a.visor.rotation.x = -(pose.pitch || 0);
      const fade = age > 2500 ? 1 - (age - 2500) / 1500 : 1;
      a.body.material.opacity = fade;
      a.body.material.transparent = fade < 1;
    }
    for (const pk of [...this.byPk.keys()]) if (!seen.has(pk)) this.remove(pk);
  }

  /** Feet positions of visible remote players, for button presses. */
  positions() {
    const out = [];
    for (const a of this.byPk.values()) if (a.group.visible) out.push(a.group.position);
    return out;
  }
}

function makeLabel(text, color) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.roundRect(0, 8, 256, 48, 12);
  ctx.fill();
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text.slice(0, 18), 128, 33);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}
