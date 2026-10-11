// app.js: boots the page, decides who you are and where you are, and runs
// the game loop. Read this file top to bottom to see every Solfray tie-in in
// the order it happens at runtime.
//
//   1. Solfray.connect()          are we inside Solfray, or a plain tab?
//   2. api.setSolfray(sf)         if inside: API calls carry playable tokens
//   3. new SolfrayNet(sf)         if inside: Solfray relays poses and events
//      new RoomNet(ws)            if not: our Durable Object room does
//   4. sf.state / setState        the host picks the map; the room follows
//   5. net.event(...)             rifts, finishes, "map changed" notices
//   6. sf.result(text)            the Wordle-style result string at the end

import * as THREE from "three";
import { World, starterMap, blankMap, BLOCK } from "./world.js";
import { Player } from "./player.js";
import { PortalGun, HeldBlock } from "./model.js";
import { Rifts } from "./rifts.js";
import { Avatars } from "./avatars.js";
import { Editor } from "./editor.js";
import { SolfrayNet, RoomNet, colorOf } from "./net.js";
import { Api } from "./api.js";

// SOLFRAY TIE-IN (guide 7c): the same string as "version" in
// /solfray-playable.json. Solfray compares the two and tells a player on a
// stale build to reload. Bump both on every deploy.
const VERSION = "1.1.0";
// Schema of the shared room state. Bump when its shape changes; a room whose
// state carries an older schema starts fresh (guide 7c, step 3).
const STATE_SCHEMA = 1;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const app = {
  sf: null,
  net: null,
  api: new Api(),
  me: { who: null, google: false }, // what OUR server thinks (from /api/me)
  world: null,
  player: new Player(),
  rifts: null,
  avatars: null,
  editor: null,
  gun: null,
  held: null,
  map: null, // { id, name, description, is_public, mine, owner } or null
  dirty: false,
  finished: false,
  startedAt: 0,
  finishes: [], // from room state: [{pk, display, ms}]
  locked: false,
  lastHud: 0,
  pendingSuggest: null,
};

// ---------------------------------------------------------------------------
// Boot

boot().catch((e) => {
  console.error(e);
  toast("Something broke while starting: " + (e && e.message), 8000);
});

async function boot() {
  const framed = window.parent !== window;

  // 1. SOLFRAY TIE-IN: connect() posts a hello to the parent window and
  //    resolves with a live session when a Solfray host answers over a
  //    MessageChannel, or with `hosted: false` after the timeout. In a tab
  //    with no parent we shorten the wait so the standalone site feels quick.
  //    ?mock=N fakes a hosted room for local development (guide section 8).
  let sf;
  if (window.Solfray && params.has("mock")) {
    sf = await Solfray.mock({ players: Math.max(1, Number(params.get("mock")) || 2) });
  } else if (window.Solfray) {
    sf = await Solfray.connect({ version: VERSION, timeout: framed ? 2500 : 400 });
  } else {
    // solfray.com unreachable: the standalone site still works.
    sf = unhostedStub();
  }
  app.sf = sf;

  // 2. SOLFRAY TIE-IN: from here on, inside Solfray, every call in api.js adds
  //    `Authorization: Bearer <playable token>` from sf.token().
  app.api.setSolfray(sf);
  app.me = await app.api.me().catch(() => ({ who: null, google: false }));

  setupThree();
  setupInput();
  setupUi();

  // 3. The network: Solfray's relay inside Solfray, our room outside.
  if (sf.hosted) attachNet(new SolfrayNet(sf));

  // SOLFRAY TIE-IN: the SDK fires this on blur, tab hidden, pointer-lock
  // loss. Clear held keys so nobody keeps walking off a ledge.
  window.addEventListener("solfray:inputreset", () => app.player.clearKeys());

  // 4. Which map?
  const wanted = params.get("map");
  const stateMap = sf.hosted && sf.state && sf.state.schema === STATE_SCHEMA ? sf.state.mapId : null;
  if (wanted) await loadMap(wanted);
  else if (stateMap) await loadMap(stateMap);
  else if (sf.hosted && !sf.isHost) showWaiting();
  else openBrowser();

  requestAnimationFrame(frame);
}

function unhostedStub() {
  return {
    hosted: false,
    me: { pk: "local", display: "You", anon: true, color: "#9aa0a6" },
    participants: [],
    state: null,
    isHost: true,
    on() {},
    token: () => Promise.reject(new Error("unhosted")),
    result() {},
  };
}

// ---------------------------------------------------------------------------
// Three.js

let renderer, scene, camera, clock;

function setupThree() {
  const canvas = $("game");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  scene.fog = new THREE.Fog(0x0e1116, 40, 110);
  camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
  camera.rotation.order = "YXZ";
  // The camera is in the scene so the first-person viewmodels (portal gun,
  // held block) can hang off it.
  scene.add(camera);
  app.gun = new PortalGun();
  camera.add(app.gun.group);
  app.held = new HeldBlock();
  app.held.group.visible = false;
  camera.add(app.held.group);
  scene.add(new THREE.HemisphereLight(0xcfd8e3, 0x2a2f36, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(30, 60, 20);
  scene.add(sun);
  const grid = new THREE.GridHelper(64, 64, 0x30363d, 0x1c2128);
  grid.position.set(32, -0.01, 32);
  scene.add(grid);

  app.world = new World(blankMap());
  scene.add(app.world.group);
  app.rifts = new Rifts(scene, renderer);
  app.avatars = new Avatars(scene);
  app.editor = new Editor(app.world, app.player, scene);
  clock = performance.now();
  resize();
  window.addEventListener("resize", resize);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Net

function attachNet(net) {
  if (app.net && app.net.close) app.net.close();
  app.net = net;
  net.on("join", (p) => {
    toast(`${p.display || short(p.pk)} joined`);
    hud();
  });
  net.on("leave", (p) => {
    app.rifts.removeAll(p.pk);
    toast(`${p.display || short(p.pk)} left`);
    hud();
  });
  net.on("host", () => {
    hud();
    if (net.isHost) toast("You are now the host: you pick the map.");
  });
  net.on("event", onEvent);
  net.on("state", onState);
  net.on("pause", () => toast("Reconnecting…"));
  net.on("resume", () => {
    toast("Back online");
    onState(net.state);
  });
  net.on("profile", (p) => app.avatars.rename({ ...p, color: colorOf(p.pk) }));
  // SOLFRAY TIE-IN (guide 6b, backburner): a player changed their skin.
  // Nothing fires until the manifest declares a "skin" slot.
  if (net.sf) net.sf.on("skin", (p) => app.avatars.reskin(p));
  hud();
}

/** Events: fire-and-tell messages from any player, mine included. */
function onEvent(from, d, meta) {
  if (!d || typeof d !== "object") return;
  const who = participant(from);
  switch (d.k) {
    case "rift":
      // SOLFRAY TIE-IN: `from` is stamped by the relay, never by the sender,
      // so a rift is always attributed to the page that really placed it.
      if (d.p && (d.which === "a" || d.which === "b")) app.rifts.place(from, d.which, d.p);
      break;
    case "clear":
      app.rifts.removeAll(from);
      break;
    case "goal":
      if (!isMe(from)) toast(`${who ? who.display : short(from)} reached the exit!`);
      if (app.net && app.net.isHost) recordFinish(from, who ? who.display : short(from), d.ms);
      break;
    case "map":
      // The owner saved. Everyone on that map reloads it (editors excepted).
      if (app.map && app.map.id === d.id && !isMe(from) && !app.editor.active) {
        toast("The map was updated; reloading it");
        loadMap(d.id, { keepPosition: true });
      }
      break;
    case "suggest":
      if (app.net && app.net.isHost && !isMe(from)) {
        app.pendingSuggest = d;
        toast(`${who ? who.display : short(from)} suggests "${d.name}". Press Y to open it.`, 8000);
      }
      break;
  }
}

/** Room state: the host's record of which map we are on and who finished. */
function onState(s) {
  if (!s || s.schema !== STATE_SCHEMA) return;
  if (s.mapId && (!app.map || app.map.id !== s.mapId)) loadMap(s.mapId);
  else if (s.mapId && app.map && app.map.id === s.mapId && s.rev && app.map.updated_at && s.rev > app.map.updated_at && !app.editor.active) {
    loadMap(s.mapId, { keepPosition: true });
  }
  app.finishes = Array.isArray(s.finishes) ? s.finishes : [];
  hud();
}

function writeState(patch) {
  // SOLFRAY TIE-IN (guide 4c, rule 6): everything the next host needs is in
  // the state. The convention here is that only the host writes it; Solfray
  // itself lets any participant, last write wins.
  if (!app.net || !app.net.isHost) return;
  const prev = app.net.state && app.net.state.schema === STATE_SCHEMA ? app.net.state : {};
  app.net.setState({ ...prev, schema: STATE_SCHEMA, ...patch });
}

function recordFinish(pk, display, ms) {
  const list = (app.finishes || []).filter((f) => f.pk !== pk).concat({ pk, display, ms: Number(ms) || 0 }).slice(0, 50);
  app.finishes = list;
  writeState({ finishes: list });
}

function participant(pk) {
  return app.net ? app.net.participants.find((p) => p.pk === pk) : null;
}
function isMe(pk) {
  return app.net && app.net.me && app.net.me.pk === pk;
}
function myPk() {
  return app.net && app.net.me ? app.net.me.pk : "local";
}
function short(pk) {
  return pk ? pk.slice(0, 4) + "…" + pk.slice(-4) : "?";
}

// ---------------------------------------------------------------------------
// Maps

async function loadMap(id, opts = {}) {
  closeOverlay();
  let meta, data;
  if (id === "starter") {
    meta = { id: "starter", name: "Starter yard", description: "The built-in teaching map. Save a copy to make it yours.", mine: false, is_public: true, owner: "Rift Builder" };
    data = starterMap();
  } else {
    try {
      const m = await app.api.getMap(id);
      data = m.data;
      delete m.data;
      meta = m;
    } catch (e) {
      toast(`Could not load map ${id}: ${e.message}`, 6000);
      if (!app.map) openBrowser();
      return;
    }
  }
  const sameMap = app.map && app.map.id === id;
  app.map = meta;
  app.world.load(data);
  app.editor.setActive(false);
  if (!sameMap || !opts.keepPosition) {
    app.rifts.clear();
    app.player.respawn(app.world);
    app.finished = false;
    app.startedAt = now();
  }
  app.dirty = false;
  document.title = `${meta.name} · Rift Builder`;

  if (app.sf.hosted) {
    // SOLFRAY TIE-IN: the host writes the chosen map into the room state so
    // late joiners and the next host land on the same map (rule 6).
    if (app.net.isHost && (!app.net.state || app.net.state.mapId !== id || app.net.state.rev !== meta.updated_at)) {
      writeState({ mapId: id, rev: meta.updated_at || 0, finishes: sameMap ? app.finishes : [] });
    }
  } else {
    // Standalone: one Durable Object room per map (plus ?room= to split).
    const room = `${id}${params.get("room") ? "-" + params.get("room").replace(/[^A-Za-z0-9_-]/g, "") : ""}`.slice(0, 64);
    if (!app.net || app.net.roomId !== room) {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const net = new RoomNet(`${proto}://${location.host}/ws/room/${encodeURIComponent(room)}`);
      net.roomId = room;
      attachNet(net);
      app.avatars.update({ participants: [], me: null });
    }
    const u = new URL(location.href);
    u.searchParams.set("map", id);
    history.replaceState(null, "", u);
  }
  if (id !== "starter" && !sameMap) app.api.bumpPlay(id);
  hud();
  toast(`Loaded "${meta.name}"${meta.owner ? " by " + meta.owner : ""}`);
}

function newMap() {
  closeOverlay();
  app.map = { id: null, name: "Untitled map", description: "", mine: true, is_public: false, owner: whoLabel() };
  app.world.load(blankMap());
  app.rifts.clear();
  app.finished = false;
  app.player.respawn(app.world);
  app.player.pos.y += 3;
  app.editor.setActive(true);
  app.dirty = true;
  if (!app.sf.hosted && app.net) {
    // A new, unsaved map has no room yet; you build alone until you save.
    app.net.close();
    app.net = null;
    app.avatars.update({ participants: [], me: null });
  }
  document.title = "New map · Rift Builder";
  hud();
  hotbar();
  toast("New map. Right click places, left click breaks, 1–9 pick a block, 0 is the spawn tool, double-tap Space to fly. Save when ready.", 8000);
}

/** Can the current identity own maps on this server? */
function canSave() {
  if (app.sf.hosted && !app.sf.me.anon && app.sf.token) return true; // Solfray wallet (mock rooms fall through to Google below)
  if (app.me.who && !app.me.who.anon) return true; // Google session
  return false;
}

async function save(form) {
  if (!app.map) return;
  const payload = { data: app.world.toJSON() };
  if (form) Object.assign(payload, { name: form.name, description: form.description, is_public: form.is_public });
  try {
    let id = app.map.id;
    if (id && id !== "starter" && app.map.mine && !(form && form.copy)) {
      await app.api.updateMap(id, payload);
    } else {
      if (!form) return openSave();
      const r = await app.api.createMap({ ...payload, name: form.name || "Untitled map", description: form.description || "", is_public: Boolean(form.is_public) });
      id = r.id;
    }
    const fresh = await app.api.getMap(id);
    delete fresh.data;
    app.map = fresh;
    app.dirty = false;
    closeOverlay();
    toast(`Saved "${fresh.name}"`);
    // Tell the room. Inside Solfray the host also bumps the state revision
    // so a late joiner gets the new version; outside, the room event does.
    if (app.net) {
      app.net.event({ k: "map", id, rev: fresh.updated_at });
      if (app.sf.hosted) {
        if (app.net.isHost) writeState({ mapId: id, rev: fresh.updated_at, finishes: [] });
        else app.net.event({ k: "suggest", id, name: fresh.name });
      } else if (app.net.roomId !== id) {
        await loadMap(id, { keepPosition: true });
      }
    } else if (!app.sf.hosted) {
      await loadMap(id, { keepPosition: true });
    }
    hud();
  } catch (e) {
    if (e.code === "unauthorized" || e.code === "guest_cannot_save" || e.status === 401 || e.status === 403) {
      toast(e.message, 7000);
      if (!app.sf.hosted) openBrowser();
    } else toast("Save failed: " + e.message, 7000);
  }
}

// ---------------------------------------------------------------------------
// Input

function setupInput() {
  const canvas = $("game");
  canvas.addEventListener("click", () => {
    if (!overlayOpen() && document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  document.addEventListener("pointerlockchange", () => {
    app.locked = document.pointerLockElement === canvas;
    app.player.clearKeys();
    document.body.classList.toggle("locked", app.locked);
  });
  document.addEventListener("mousemove", (e) => {
    if (app.locked) app.player.look(e.movementX, e.movementY);
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mousedown", (e) => {
    if (!app.locked) return;
    if (app.editor.active) {
      // Creative-mode mouse: left breaks, right places, middle picks.
      if (e.button === 0 && app.editor.breakBlock()) app.dirty = true;
      if (e.button === 2 && app.editor.placeBlock()) app.dirty = true;
      if (e.button === 1) {
        e.preventDefault();
        app.editor.pickBlock();
        hotbar();
      }
      hud();
    } else {
      if (e.button === 0) shoot("a");
      if (e.button === 2) shoot("b");
    }
  });
  canvas.addEventListener("auxclick", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    if (app.editor.active) {
      app.editor.cycle(e.deltaY > 0 ? 1 : -1);
      hotbar();
    }
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (overlayOpen()) {
      if (e.code === "Escape") closeOverlay();
      return;
    }
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (!e.repeat) app.player.keyPressed(e.code, performance.now());
    app.player.keys.add(e.code);
    switch (e.code) {
      case "KeyR":
        app.player.respawn(app.world);
        break;
      case "KeyX":
        if (app.net) app.net.event({ k: "clear" });
        else app.rifts.removeAll(myPk());
        break;
      case "KeyB":
      case "Tab":
        e.preventDefault();
        toggleBuild();
        break;
      case "KeyM":
        openBrowser();
        break;
      case "KeyH":
      case "F1":
        e.preventDefault();
        openHelp();
        break;
      case "KeyY":
        if (app.pendingSuggest) {
          const s = app.pendingSuggest;
          app.pendingSuggest = null;
          loadMap(s.id);
        }
        break;
      default:
        if (app.editor.active && /^Digit[0-9]$/.test(e.code)) {
          app.editor.selectDigit(Number(e.code.slice(5)));
          hotbar();
        }
    }
    if (e.code === "Space") e.preventDefault();
  });
  document.addEventListener("keyup", (e) => app.player.keys.delete(e.code));
  window.addEventListener("blur", () => app.player.clearKeys());
}

function shoot(which) {
  const p = app.rifts.aim(app.world, app.player.eye(), app.player.forward(), app.player.yaw);
  if (!p) {
    $("crosshair").classList.add("no");
    setTimeout(() => $("crosshair").classList.remove("no"), 150);
    return;
  }
  app.gun.fire(which === "a" ? 0x3fa9ff : 0xff9a3f);
  // SOLFRAY TIE-IN (guide 4c, rule 4): an event, not a state write. My own
  // handler runs now; everyone else's when it lands.
  if (app.net) app.net.event({ k: "rift", which, p });
  else app.rifts.place(myPk(), which, p);
}

function toggleBuild() {
  if (!app.map) return;
  if (!app.editor.active) {
    if (!app.map.mine && app.map.id) {
      toast("This is someone else's map. Save a copy (Save → Save a copy) to edit it.", 6000);
      return;
    }
    app.editor.setActive(true);
    app.player.pos.y += 0.5;
  } else {
    app.editor.setActive(false);
    app.player.vel.set(0, 0, 0);
  }
  hud();
  hotbar();
}

// ---------------------------------------------------------------------------
// Game loop

const tmpCenter = new THREE.Vector3(), tmpPrev = new THREE.Vector3();

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - clock) / 1000);
  clock = t;
  simulate(dt);
  render();
  if (t - app.lastHud > 500) {
    app.lastHud = t;
    hud();
  }
}

/** One step of the game: input, physics, rifts, hazards, goal. Kept apart
 *  from rendering so it can be driven from a test (window.__rift.simulate). */
function simulate(dt) {
  const world = app.world, player = app.player;

  world.rebuild();
  app.editor.update();

  // Buttons and doors are derived from where everyone stands, so every page
  // agrees without a host: a deterministic function of the poses it sees.
  const feet = [player.pos, ...app.avatars.positions()];
  world.setDoorsOpen(world.buttonsPressedBy(feet));

  if (!overlayOpen() || app.editor.active) {
    player.center(tmpPrev);
    world.passable = app.editor.active ? null : app.rifts.passable(tmpPrev);
    player.update(dt, world);
    world.passable = null;
    if (!app.editor.active) {
      player.center(tmpCenter);
      const x = app.rifts.crossing(tmpPrev, tmpCenter);
      if (x) teleport(x);
      if (player.pos.y < -12 || player.touching(world, BLOCK.HAZARD)) {
        player.respawn(world);
        toast("Back to the start.");
      }
      if (!app.finished && player.touching(world, BLOCK.GOAL)) finish();
    }
  }

  if (app.net) {
    // SOLFRAY TIE-IN (guide 4c, rule 1): my pose every frame; the SDK (or
    // RoomNet) streams it at 15 Hz. Others are drawn from poseOf().
    app.net.pose(player.pose());
    app.avatars.update(app.net, dt);
  }

  // First-person viewmodels: the portal gun when playing, the selected
  // block when building.
  app.gun.group.visible = !app.editor.active;
  app.gun.animate(dt);
  if (app.editor.active) app.held.setBlock(app.editor.tool === "block" ? app.editor.info : null);
  else app.held.group.visible = false;
  app.held.animate(dt);
}

function render() {
  const player = app.player;
  camera.position.copy(player.eye());
  camera.rotation.set(player.pitch, player.yaw + Math.PI, 0);
  // Sprinting widens the view a touch, as players expect.
  const fov = player.sprinting ? 76 : 70;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov += (fov - camera.fov) * 0.2;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
  // The viewmodels are not part of the world the rifts look into.
  const gunVisible = app.gun.group.visible, heldVisible = app.held.group.visible;
  app.gun.group.visible = app.held.group.visible = false;
  app.rifts.renderViews(scene, camera, myPk());
  app.gun.group.visible = gunVisible;
  app.held.group.visible = heldVisible;
  renderer.render(scene, camera);
}

function teleport(x) {
  const player = app.player;
  const R = new THREE.Matrix3().setFromMatrix4(x.m);
  const center = player.center().applyMatrix4(x.m);
  player.pos.copy(center).sub({ x: 0, y: 0.9, z: 0 }).addScaledVector(x.to.normal, 0.08);
  player.vel.applyMatrix3(R);
  const fwd = player.forward().applyMatrix3(R);
  player.yaw = Math.atan2(fwd.x, fwd.z);
  player.pitch = Math.max(-1.5, Math.min(1.5, Math.asin(Math.max(-1, Math.min(1, fwd.y)))));
  // Never fall straight back in: leave with a little speed along the exit normal.
  const along = player.vel.dot(x.to.normal);
  if (along < 2) player.vel.addScaledVector(x.to.normal, 2 - along);
  player.onGround = false;
  // The body is taller than the oval is wide, so a low crossing can leave
  // the feet inside the blocks around the exit (a wall's bottom row, say).
  // Nudge out along the exit normal until clear; the exit's own backing
  // cells do not count.
  app.world.passable = new Set(x.to.cells.map((c) => c.join(",")));
  for (let i = 0; i < 8 && player.collides(app.world); i++) player.pos.addScaledVector(x.to.normal, 0.08);
  app.world.passable = null;
}

function now() {
  return app.net ? app.net.now() : Date.now();
}

function finish() {
  app.finished = true;
  const ms = Math.max(0, now() - app.startedAt);
  toast(`You reached the exit in ${fmt(ms)}!`, 6000);
  if (app.net) app.net.event({ k: "goal", ms });
  else app.finishes = [{ pk: "local", display: "You", ms }];
  offerResult();
}

/** SOLFRAY TIE-IN (guide section 6): the result string. Plain text, under 500
 *  characters, the thread link last. sf.result() lights up "Post final score"
 *  in Solfray's chrome; the Copy button in our HUD works everywhere. */
function resultText() {
  const me = app.net && app.net.me ? app.net.me : { display: "You", pk: "local" };
  const list = (app.finishes.length ? app.finishes : [{ pk: me.pk, display: me.display, ms: now() - app.startedAt }])
    .slice()
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 8);
  const n = app.net ? app.net.participants.length : 1;
  const medals = ["🥇", "🥈", "🥉"];
  const lines = [
    `Rift Builder · ${app.map ? app.map.name : "a map"} · ${n} player${n === 1 ? "" : "s"} · ${new Date().toISOString().slice(0, 10)}`,
    ...list.map((f, i) => `${medals[i] || "🏁"} ${f.display} ${fmt(f.ms)}`),
  ];
  if (app.sf.hosted && app.sf.server && app.sf.thread) lines.push(`solfray.com/s/${app.sf.server.slug}/t/${app.sf.thread.root_id}`);
  else if (app.map && app.map.id) lines.push(`${location.origin}/?map=${app.map.id}`);
  return lines.join("\n").slice(0, 500);
}

function offerResult() {
  const text = resultText();
  if (app.net && app.net.result) app.net.result(text);
  $("btn-result").hidden = false;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// HUD and overlays

function whoLabel() {
  if (app.sf.hosted) {
    const me = app.sf.me;
    return `${me.display}${me.anon ? " (guest)" : ""}`;
  }
  if (app.me.who) return app.me.who.display;
  return "Guest";
}

function setupUi() {
  $("btn-maps").onclick = openBrowser;
  $("btn-build").onclick = toggleBuild;
  $("btn-save").onclick = () => (app.map && app.map.id && app.map.id !== "starter" && app.map.mine ? save() : openSave());
  $("btn-help").onclick = openHelp;
  $("btn-result").onclick = async () => {
    try {
      await navigator.clipboard.writeText(resultText());
      toast("Result copied");
    } catch {
      prompt("Copy your result:", resultText());
    }
  };
  $("overlay").addEventListener("click", (e) => {
    if (e.target === $("overlay")) closeOverlay();
  });
  $("hotbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-slot]");
    if (!b) return;
    app.editor.selectSlot(Number(b.dataset.slot));
    hotbar();
  });
  hud();
}

function hud() {
  const n = app.net ? app.net.participants.length : 1;
  $("who").textContent = whoLabel();
  $("who").title = app.sf.hosted
    ? "Identity from Solfray: proven to this server with a playable token"
    : app.me.who
      ? "Signed in with Google on this site"
      : "Not signed in: you can play, but not save";
  $("where").textContent = app.sf.hosted ? "inside Solfray" : app.net ? "standalone room" : "solo";
  $("mapname").textContent = app.map ? app.map.name + (app.dirty ? " •" : "") : "no map";
  $("players").textContent = `${n} player${n === 1 ? "" : "s"}${app.net && app.net.isHost ? " · host" : ""}`;
  $("btn-build").textContent = app.editor && app.editor.active ? "Play (B)" : "Build (B)";
  $("btn-build").disabled = !app.map;
  $("btn-save").disabled = !app.map;
  $("btn-save").textContent = app.map && app.map.id && app.map.id !== "starter" && app.map.mine ? "Save" : "Save as…";
  $("hotbar-wrap").hidden = !(app.editor && app.editor.active);
  $("hint").textContent = app.editor && app.editor.active
    ? "WASD · double-tap Space to fly (Space up, Shift down) · Ctrl fast · RMB place · LMB break · MMB pick · wheel/1–9 block · 0 spawn tool · B play"
    : "WASD · Space jump · Shift sneak · Ctrl sprint · LMB blue rift · RMB orange rift · X clear rifts · R restart · B build · M maps";
}

function hotbar() {
  $("hotbar").innerHTML = app.editor.hotbarHtml();
  $("hotbar-label").textContent = app.editor.slotLabel();
}

function toast(text, ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

function overlayOpen() {
  return !$("overlay").hidden;
}
function closeOverlay() {
  $("overlay").hidden = true;
  $("overlay-body").innerHTML = "";
}
function showOverlay(html) {
  if (document.pointerLockElement) document.exitPointerLock();
  $("overlay-body").innerHTML = html;
  $("overlay").hidden = false;
}

function showWaiting() {
  showOverlay(`<h2>Waiting for the host</h2>
    <p>The host (the first player in, or whoever Solfray elected) picks the map for everyone. Hang tight, or suggest one:</p>
    <p><button id="ov-browse">Browse maps</button></p>`);
  $("ov-browse").onclick = openBrowser;
}

async function openBrowser() {
  showOverlay(`<h2>Maps</h2><div class="tabs"><button data-scope="public" class="sel">Public</button><button data-scope="mine">Mine</button></div>
    <div id="maplist" class="list">Loading…</div>
    <div class="row">
      <button id="ov-new">New map</button>
      <button id="ov-starter">Starter yard</button>
      <span class="grow"></span>
      ${signinHtml()}
    </div>
    <p class="muted" id="identity-note">${identityNote()}</p>`);
  $("ov-new").onclick = newMap;
  $("ov-starter").onclick = () => pickMap("starter", "Starter yard");
  wireSignin();
  const tabs = $("overlay-body").querySelectorAll(".tabs button");
  tabs.forEach((b) => (b.onclick = () => {
    tabs.forEach((x) => x.classList.toggle("sel", x === b));
    fillList(b.dataset.scope);
  }));
  fillList("public");
}

async function fillList(scope) {
  const el = $("maplist");
  if (!el) return;
  el.textContent = "Loading…";
  try {
    const { maps } = await app.api.listMaps(scope);
    if (!maps.length) {
      el.innerHTML = `<p class="muted">${scope === "mine" ? "You have not saved any maps yet." : "No public maps yet. Be the first: New map → Save as… → tick Public."}</p>`;
      return;
    }
    el.innerHTML = maps
      .map(
        (m) => `<div class="map" data-id="${m.id}">
          <div class="grow"><b>${esc(m.name)}</b> <span class="muted">by ${esc(m.owner)}${m.mine ? " (you)" : ""} · ${m.plays} plays${m.is_public ? "" : " · private"}</span><br><span class="muted">${esc(m.description || "")}</span></div>
          <button data-act="play">Play</button>
          ${m.mine ? `<button data-act="edit">Edit</button><button data-act="del" class="danger">Delete</button>` : ""}
        </div>`
      )
      .join("");
    el.querySelectorAll(".map").forEach((row) => {
      row.querySelector('[data-act="play"]').onclick = () => pickMap(row.dataset.id, row.querySelector("b").textContent);
      const edit = row.querySelector('[data-act="edit"]');
      if (edit) edit.onclick = async () => {
        await loadMap(row.dataset.id);
        app.editor.setActive(true);
        hud();
        hotbar();
      };
      const del = row.querySelector('[data-act="del"]');
      if (del) del.onclick = async () => {
        if (!confirm("Delete this map for good?")) return;
        await app.api.deleteMap(row.dataset.id).catch((e) => toast(e.message));
        fillList(scope);
      };
    });
  } catch (e) {
    el.innerHTML = `<p class="muted">${esc(e.message)}${scope === "mine" ? ". Sign in to see your maps." : ""}</p>`;
  }
}

/** Picking a map inside Solfray is the host's call; others suggest. */
function pickMap(id, name) {
  if (app.sf.hosted && app.net && !app.net.isHost) {
    app.net.event({ k: "suggest", id, name });
    closeOverlay();
    toast(`Suggested "${name}" to the host`);
    return;
  }
  loadMap(id);
}

function openSave() {
  if (!app.map) return;
  if (!canSave()) {
    showOverlay(`<h2>Sign in to save</h2>
      <p>${identityNote()}</p>
      <div class="row">${signinHtml()}</div>`);
    wireSignin();
    return;
  }
  const copy = !(app.map.id && app.map.id !== "starter" && app.map.mine);
  showOverlay(`<h2>${copy ? "Save a copy" : "Save"}</h2>
    <label>Name <input id="sv-name" maxlength="48" value="${esc(copy && app.map.id ? app.map.name + " (copy)" : app.map.name)}"></label>
    <label>Description <textarea id="sv-desc" maxlength="300" rows="2">${esc(app.map.description || "")}</textarea></label>
    <label class="check"><input type="checkbox" id="sv-public" ${app.map.is_public ? "checked" : ""}> Public: list it for everyone</label>
    <div class="row"><button id="sv-ok" class="primary">${copy ? "Save copy" : "Save"}</button><button id="sv-cancel">Cancel</button></div>
    <p class="muted">Saved under <b>${esc(whoLabel())}</b>${app.sf.hosted ? " (your Solfray identity, proven to this server by a playable token)" : " (your Google account on this site)"}.</p>`);
  $("sv-cancel").onclick = closeOverlay;
  $("sv-ok").onclick = () => save({ name: $("sv-name").value.trim(), description: $("sv-desc").value.trim(), is_public: $("sv-public").checked, copy });
}

function openHelp() {
  showOverlay(`<h2>Rift Builder</h2>
    <p>Place two linked rifts on <b>light panels</b> (left click blue, right click orange), walk through one and come out of the other with your speed intact. Reach the green exit pad. Dark plates and glass refuse rifts; acid sends you back; a floor button held down by any player opens every door, so bring friends.</p>
    <p><b>Play</b>: WASD, Space jumps, Shift sneaks (slower, never off an edge), Ctrl sprints. Left click fires the blue rift, right click the orange one. Stairs are slopes: a rift aimed at a two-step run sits on the slope, and a rift aimed at a floor or wall needs two panels of room.</p>
    <p><b>Build</b> (B): creative controls. Double-tap Space to fly (Space up, Shift down, Ctrl fast). Right click places the selected block against the face you look at, left click breaks, middle click picks. Keys 1–9 and the wheel choose a block from the hotbar; 0 is the spawn tool (right click a block to spawn on it). Stairs face the way you look; placed under a block they hang upside down. Save as… stores the map on this server under your account; tick Public to list it.</p>
    <h3>Who you are</h3>
    <p>${identityNote()}</p>
    <h3>Multiplayer</h3>
    <p>${app.sf.hosted
      ? "You are inside Solfray. Everyone who pressed Launch on this thread is in the room; Solfray relays positions and events, and the host (starred in Solfray's lobby) picks the map."
      : "You are on the standalone site. Everyone on the same map shares a room (add ?room=anything to the URL for a private one). Up to 50 players."}</p>
    <p class="muted">Open source, MIT. An example of a server-backed Solfray playable.</p>
    <div class="row"><button id="hp-ok" class="primary">Close</button></div>`);
  $("hp-ok").onclick = closeOverlay;
}

function identityNote() {
  if (app.sf.hosted && app.sf.me.anon) return "You are a Solfray guest. Guests can play everything but not save maps: sign in to Solfray with a wallet and relaunch.";
  if (app.sf.hosted) return `You are <b>${esc(app.sf.me.display)}</b> on Solfray. Saving sends this server a playable token signed by solfray.com that names your key; the server verifies the signature against solfray.com's public key, so nobody can save or edit as you just by typing your key.`;
  if (app.me.who) return `Signed in with Google as <b>${esc(app.me.who.display)}</b>. Your maps are tied to that account.`;
  if (app.me.google) return "Sign in with Google to save maps. Playing needs no account.";
  return "Google sign-in is not configured on this deployment (see README.md), so saving works only through Solfray. Playing needs no account.";
}

function signinHtml() {
  if (app.sf.hosted) return "";
  if (app.me.who) return `<button id="ov-signout">Sign out</button>`;
  if (app.me.google) return `<a class="button primary" href="/auth/google/login?return_to=${encodeURIComponent(location.pathname + location.search)}">Sign in with Google</a>`;
  return "";
}

function wireSignin() {
  const so = $("ov-signout");
  if (so) so.onclick = async () => {
    await app.api.logout();
    location.reload();
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// For poking around in the console, and for driving the simulation from a test.
app.simulate = simulate;
app.render = render;
window.__rift = app;
