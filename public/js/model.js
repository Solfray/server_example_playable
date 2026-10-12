// model.js: the blocky humanoid every player is drawn as, and the portal gun
// held in first person.
//
// The character is six boxes (head, body, two arms, two legs) in the classic
// 64x64 "skin" layout: one square image wraps the whole figure, with each box
// face cut from a fixed rectangle of the image. The rectangles below are the
// standard ones, so any ready-made skin in that layout drops straight in via
// setSkin(image). Players without a skin get makeDefaultSkin(): a flat-colour
// skin in their Solfray colour, painted through exactly the same UVs.
//
// SOLFRAY TIE-IN (guide 6b, sprite injection): /solfray-playable.json
// declares one 64x64 "skin" slot whose default, /assets/skin-default.png, is
// this same figure in neutral grey: the template players download from
// Solfray's Sprites button to paint their own. avatars.js loads each
// player's pick and hands it to setSkin().

import * as THREE from "three";
import { PLAYER } from "./player.js";

const TEX = 64; // skin image is 64x64
const PX = PLAYER.height / 32; // the model is 32 px tall and stands 1.8 units

/** [u, v, w, h, d] texture origin and box size in pixels for each part. */
const PARTS = {
  head: { u: 0, v: 0, w: 8, h: 8, d: 8 },
  body: { u: 16, v: 16, w: 8, h: 12, d: 4 },
  rightArm: { u: 40, v: 16, w: 4, h: 12, d: 4 },
  leftArm: { u: 32, v: 48, w: 4, h: 12, d: 4 },
  rightLeg: { u: 0, v: 16, w: 4, h: 12, d: 4 },
  leftLeg: { u: 16, v: 48, w: 4, h: 12, d: 4 },
};

/** Lay a box's six faces over the skin rectangle at (u,v) the standard way:
 *  top and bottom above, then right / front / left / back in a row. The model
 *  faces +Z; its right side is -X. BoxGeometry face order is +x,-x,+y,-y,+z,-z
 *  and each face's four UVs run top-left, top-right, bottom-left, bottom-right. */
function boxWithSkinUV(part) {
  const { u, v, w, h, d } = part;
  const geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  const rects = [
    [u + d + w, v + d, d, h], // +x: the model's left side
    [u, v + d, d, h], // -x: right side
    [u + d, v, w, d], // +y: top
    [u + d + w, v, w, d], // -y: bottom
    [u + d, v + d, w, h], // +z: front
    [u + 2 * d + w, v + d, w, h], // -z: back
  ];
  const uv = geo.attributes.uv;
  rects.forEach(([x, y, rw, rh], face) => {
    const u0 = x / TEX, u1 = (x + rw) / TEX, v0 = 1 - y / TEX, v1 = 1 - (y + rh) / TEX;
    const i = face * 4;
    uv.setXY(i, u0, v0);
    uv.setXY(i + 1, u1, v0);
    uv.setXY(i + 2, u0, v1);
    uv.setXY(i + 3, u1, v1);
  });
  uv.needsUpdate = true;
  return geo;
}

/** A flat-colour skin: head in a skin tone with two eyes, body in the
 *  player's colour, limbs a shade darker. Same layout as a real skin. */
export function makeDefaultSkin(colorHex) {
  const c = document.createElement("canvas");
  c.width = c.height = TEX;
  const ctx = c.getContext("2d");
  const base = new THREE.Color(colorHex || "#888888");
  const dark = base.clone().multiplyScalar(0.7);
  const fill = (part, col) => {
    const { u, v, w, h, d } = part;
    ctx.fillStyle = "#" + col.getHexString();
    ctx.fillRect(u, v, 2 * w + 2 * d, d + h);
  };
  fill(PARTS.head, new THREE.Color(0xe0b89a));
  fill(PARTS.body, base);
  fill(PARTS.rightArm, dark);
  fill(PARTS.leftArm, dark);
  fill(PARTS.rightLeg, new THREE.Color(0x30343c));
  fill(PARTS.leftLeg, new THREE.Color(0x30343c));
  // Hair on top of the head, and a face: two eyes and a mouth on the front rect.
  ctx.fillStyle = "#" + dark.getHexString();
  ctx.fillRect(8, 0, 8, 8);
  ctx.fillRect(8, 8, 32, 2);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(10, 12, 2, 1);
  ctx.fillRect(13, 12, 2, 1);
  ctx.fillStyle = "#223";
  ctx.fillRect(11, 12, 1, 1);
  ctx.fillRect(13, 12, 1, 1);
  ctx.fillStyle = "#a0624a";
  ctx.fillRect(11, 14, 3, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Wrap an Image (a real 64x64 skin) as a texture with the right filtering. */
export function skinTexture(image) {
  const tex = new THREE.Texture(image);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class Character {
  constructor(colorHex) {
    this.group = new THREE.Group(); // origin at the feet, facing +Z
    this.material = new THREE.MeshLambertMaterial({ map: makeDefaultSkin(colorHex) });
    const mk = (part) => new THREE.Mesh(boxWithSkinUV(PARTS[part]), this.material);

    // Pivots so limbs swing from the joint and the head turns at the neck.
    this.head = pivot(mk("head"), 0, 24 * PX, 0, 0, 4 * PX, 0);
    this.body = mk("body");
    this.body.position.set(0, 18 * PX, 0);
    this.rightArm = pivot(mk("rightArm"), -6 * PX, 22 * PX, 0, 0, -4 * PX, 0);
    this.leftArm = pivot(mk("leftArm"), 6 * PX, 22 * PX, 0, 0, -4 * PX, 0);
    this.rightLeg = pivot(mk("rightLeg"), -2 * PX, 12 * PX, 0, 0, -6 * PX, 0);
    this.leftLeg = pivot(mk("leftLeg"), 2 * PX, 12 * PX, 0, 0, -6 * PX, 0);
    this.group.add(this.head, this.body, this.rightArm, this.leftArm, this.rightLeg, this.leftLeg);
    this.phase = 0;
  }

  setSkin(imageOrTexture) {
    const tex = imageOrTexture instanceof THREE.Texture ? imageOrTexture : skinTexture(imageOrTexture);
    const old = this.material.map;
    this.material.map = tex;
    this.material.needsUpdate = true;
    if (old) old.dispose();
  }

  /** Per-frame: `speed` in units/s drives the walk cycle, `pitch` tilts the
   *  head, `sneaking` crouches the figure. */
  animate(dt, speed, pitch, sneaking) {
    this.phase += dt * Math.min(speed, 8) * 2.2;
    const swing = Math.min(1, speed / 4) * 0.8;
    const s = Math.sin(this.phase) * swing;
    this.rightLeg.rotation.x = s;
    this.leftLeg.rotation.x = -s;
    this.rightArm.rotation.x = -s;
    this.leftArm.rotation.x = s;
    this.head.rotation.x = -(pitch || 0);
    const crouch = sneaking ? 1 : 0;
    this.body.rotation.x = crouch * 0.45;
    this.body.position.y = (18 - crouch * 1.5) * PX;
    this.head.position.y = (24 - crouch * 4) * PX;
    this.head.position.z = crouch * 3 * PX;
    this.rightArm.position.y = this.leftArm.position.y = (22 - crouch * 3) * PX;
    this.rightArm.position.z = this.leftArm.position.z = crouch * 2 * PX;
  }

  setOpacity(o) {
    this.material.opacity = o;
    this.material.transparent = o < 1;
  }

  dispose() {
    this.group.traverse((o) => o.isMesh && o.geometry.dispose());
    if (this.material.map) this.material.map.dispose();
    this.material.dispose();
  }
}

/** Wrap a mesh in a group placed at the joint, with the mesh offset so the
 *  group's rotation swings it from that joint. */
function pivot(mesh, x, y, z, ox, oy, oz) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  mesh.position.set(ox, oy, oz);
  g.add(mesh);
  return g;
}

// ---- the portal gun ----------------------------------------------------------
//
// A blocky handheld device: a grip, a boxy body, a short barrel, three claws
// and a glowing core that takes the colour of the last rift fired. Built from
// boxes so it reads as part of the same world as the blocks and characters.
// Untextured; `material.map` is the hook when textures arrive.

export class PortalGun {
  constructor() {
    this.group = new THREE.Group();
    const body = new THREE.MeshLambertMaterial({ color: 0xf2f3f5 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x23272e });
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0x3fa9ff });
    const box = (w, h, d, x, y, z, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      return mesh;
    };
    box(0.09, 0.2, 0.09, 0, -0.14, 0.04, dark); // grip
    box(0.16, 0.14, 0.34, 0, 0, -0.08, body); // body
    box(0.1, 0.1, 0.16, 0, 0.02, -0.3, dark); // barrel
    box(0.03, 0.03, 0.2, 0.07, 0.07, -0.38, body); // claws
    box(0.03, 0.03, 0.2, -0.07, 0.07, -0.38, body);
    box(0.03, 0.03, 0.2, 0, -0.07, -0.38, body);
    this.core = box(0.07, 0.07, 0.07, 0, 0.02, -0.42, this.coreMat);
    this.light = new THREE.PointLight(0x3fa9ff, 0.6, 3);
    this.light.position.set(0, 0.02, -0.42);
    this.group.add(this.light);
    this.recoil = 0;
    this.pulse = 0;
    // Where it rests in camera space: low right, far enough back to read as
    // a handheld rather than a wall.
    this.rest = new THREE.Vector3(0.3, -0.32, -0.95);
    this.group.scale.setScalar(0.75);
  }

  /** Flash the core in the colour of the rift just fired and kick back. */
  fire(colorHex) {
    this.coreMat.color.set(colorHex);
    this.light.color.set(colorHex);
    this.recoil = 1;
    this.pulse = 1;
  }

  animate(dt) {
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.pulse = Math.max(0, this.pulse - dt * 3);
    this.group.position.copy(this.rest);
    this.group.position.z += this.recoil * 0.12;
    this.group.rotation.x = this.recoil * 0.25;
    const s = 1 + this.pulse * 0.6;
    this.core.scale.set(s, s, s);
    this.light.intensity = 0.4 + this.pulse * 1.5;
  }
}

/** A small floating cube of the selected block, held in build mode. */
export class HeldBlock {
  constructor() {
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), this.material);
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.bob = 0;
  }
  setBlock(info) {
    if (!info) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.material.color.set(info.color);
    this.material.emissive.set(info.emissive || 0);
    this.material.opacity = info.opacity === undefined ? 1 : Math.max(0.4, info.opacity);
    this.material.transparent = this.material.opacity < 1;
  }
  animate(dt) {
    this.bob += dt;
    this.mesh.rotation.y += dt * 0.8;
    this.group.position.set(0.3, -0.3 + Math.sin(this.bob * 2) * 0.01, -0.9);
  }
}
