// avatars.js: the other players, drawn from interpolated poses as blocky
// characters (model.js).
//
// SOLFRAY TIE-IN (guide 4c, rule 2): remote players come from net.poseOf(pk),
// never snapped to the raw frames. Each participant's `color` is the one
// Solfray derives from their key (Solfray.colorOf), so a friend is the same
// colour here as in every other playable, and `display` is the name the chat
// shows them under. Players whose pose is older than a few seconds fade out.
//
// SOLFRAY TIE-IN (guide 6b, sprite injection): the manifest declares one
// "skin" slot (64x64, default /assets/skin-default.png), so `p.skin.skin` is
// the URL of the skin a player chose on Solfray's Sprites button: one they
// uploaded or painted from their pfp, already moderated and filtered by
// Solfray. applySkin() loads it with Solfray.loadImage (CORS-safe, so the
// screenshot button keeps working) and keeps the player's coloured default
// when the slot is empty, the load fails, or the picture is the wrong size.
// We don't do NFT injection (guide 6c).

import * as THREE from "three";
import { PLAYER } from "./player.js";
import { Character, makeDefaultSkin } from "./model.js";

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
    const g = new THREE.Group();
    const character = new Character(p.color || "#888888");
    g.add(character.group);
    const label = makeLabel(p.display || p.pk.slice(0, 6), p.color || "#888888");
    label.position.y = PLAYER.height + 0.35;
    g.add(label);
    a = { group: g, character, label, last: null, lastT: 0, speed: 0, skinUrl: null };
    this.byPk.set(p.pk, a);
    this.group.add(g);
    this.applySkin(a, p);
    return a;
  }

  /** Sprite injection: dress a player in their own skin, or in the default
   *  coloured one when they have none (or just cleared theirs). */
  applySkin(a, p) {
    const url = (p.skin && p.skin.skin) || null;
    if (url === a.skinUrl) return;
    a.skinUrl = url;
    if (!url || !window.Solfray || !window.Solfray.loadImage) {
      a.character.setSkin(makeDefaultSkin(p.color || "#888888"));
      return;
    }
    window.Solfray.loadImage(url)
      .then((img) => {
        // A newer pick may have landed while this one loaded; the layout
        // needs a square 64x64 picture (Solfray scales uploads to the slot).
        if (a.skinUrl !== url || img.naturalWidth !== 64 || img.naturalHeight !== 64) return;
        a.character.setSkin(img);
      })
      .catch(() => {}); // keep the default skin
  }

  rename(p) {
    const a = this.byPk.get(p.pk);
    if (!a) return;
    a.group.remove(a.label);
    a.label = makeLabel(p.display || p.pk.slice(0, 6), p.color || "#888888");
    a.label.position.y = PLAYER.height + 0.35;
    a.group.add(a.label);
  }

  reskin(p) {
    const a = this.byPk.get(p.pk);
    if (a) this.applySkin(a, p);
  }

  remove(pk) {
    const a = this.byPk.get(pk);
    if (!a) return;
    this.group.remove(a.group);
    a.character.dispose();
    this.byPk.delete(pk);
  }

  /** Called every frame. */
  update(net, dt = 1 / 60) {
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
      // Speed from how far the interpolated position moved: drives the walk cycle.
      if (a.last) {
        const d = Math.hypot(pose.x - a.last.x, pose.z - a.last.z);
        const v = dt > 0 ? d / dt : 0;
        a.speed += (v - a.speed) * Math.min(1, dt * 8);
      } else a.last = new THREE.Vector3();
      a.last.set(pose.x, pose.y, pose.z);
      a.group.position.set(pose.x, pose.y, pose.z);
      a.group.rotation.y = pose.yaw || 0;
      a.character.animate(dt, a.speed, pose.pitch || 0, Boolean(pose.c));
      const fade = age > 2500 ? 1 - (age - 2500) / 1500 : 1;
      a.character.setOpacity(fade);
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
