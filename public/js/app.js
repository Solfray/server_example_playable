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
import { World, blankMap, builtinMap, isBuiltinMap, isTemplateMap, listTemplateMaps, BLOCK } from "./world.js";
import { Player } from "./player.js";
import { PortalGun, HeldBlock } from "./model.js";
import { Rifts } from "./rifts.js";
import { Avatars } from "./avatars.js";
import { Editor } from "./editor.js";
import { SolfrayNet, RoomNet, colorOf } from "./net.js";
import { Api } from "./api.js";
import { TouchControls } from "./touch.js";

// SOLFRAY TIE-IN (guide 7c): the same string as "version" in
// /solfray-playable.json. Solfray compares the two and tells a player on a
// stale build to reload. Bump both on every deploy.
const VERSION = "1.6.0";
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
    // &skin=<https url> dresses the mock bots in that skin, to test sprite
    // injection (guide 6b) without publishing.
    const players = Math.max(1, Number(params.get("mock")) || 2);
    const opts = { players };
    if (params.get("skin")) opts.skins = Array.from({ length: players }, () => ({ skin: params.get("skin") }));
    sf = await Solfray.mock(opts);
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
  // SOLFRAY TIE-IN (guide 6b): a player picked, changed or cleared their
  // skin on Solfray's Sprites button; repaint their character.
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
  // An unsaved map (blank, or started from a template) is local until Save.
  // Don't let the room's current map wipe it.
  const editingNew = app.map && !app.map.id && (app.dirty || (app.editor && app.editor.active));
  if (!editingNew) {
    if (s.mapId && (!app.map || app.map.id !== s.mapId)) loadMap(s.mapId);
    else if (s.mapId && app.map && app.map.id === s.mapId && s.rev && app.map.updated_at && s.rev > app.map.updated_at && !app.editor.active) {
      loadMap(s.mapId, { keepPosition: true });
    }
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
  const builtin = builtinMap(id);
  if (builtin) {
    meta = { id: builtin.id, name: builtin.name, description: builtin.description, mine: false, is_public: true, owner: "Rift Builder" };
    data = builtin.data;
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
  if (!isBuiltinMap(id) && !sameMap) app.api.bumpPlay(id);
  hud();
  toast(`Loaded "${meta.name}"${meta.owner ? " by " + meta.owner : ""}`);
}

function newMap() {
  beginNewMap(blankMap(), "Untitled map", "", { lift: true });
  toast("New map. Right click places, left click breaks, 1–9 pick a block, 0 is the spawn tool, double-tap Space to fly. Save when ready.", 8000);
}

/** Open an editable unsaved map. Saving creates a row owned by the verified
 *  identity (POST /api/maps); this payload never names an owner. */
function beginNewMap(data, name, description, opts = {}) {
  closeOverlay();
  app.map = { id: null, name, description, mine: true, is_public: false, owner: whoLabel() };
  app.world.load(data);
  app.rifts.clear();
  app.finished = false;
  app.startedAt = now();
  app.player.respawn(app.world);
  if (opts.lift) app.player.pos.y += 3;
  app.editor.setActive(true);
  app.dirty = true;
  if (!app.sf.hosted && app.net) {
    // A new, unsaved map has no room yet; you build alone until you save.
    app.net.close();
    app.net = null;
    app.avatars.update({ participants: [], me: null });
  }
  if (!app.sf.hosted) {
    const u = new URL(location.href);
    u.searchParams.delete("map");
    history.replaceState(null, "", u);
  }
  document.title = `${name} · Rift Builder`;
  hud();
  hotbar();
}

/** Fork a base template into a new map and drop straight into build mode.
 *  The shared template stays read-only; the copy is yours once you save. */
function startFromTemplate(id) {
  const builtin = builtinMap(id);
  if (!builtin || !builtin.template) return;
  beginNewMap(builtin.data, builtin.name, builtin.description);
  toast(`Started a new map from “${builtin.name}”. Build on it, then Save to keep it as yours.`, 8000);
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
    if (id && !isBuiltinMap(id) && app.map.mine && !(form && form.copy)) {
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

  // ---- Mouse: click to capture, then the mouse looks around ----------------
  // As in desktop block games, the first click only captures the pointer
  // (pointer lock); after that moving the mouse turns the view and the
  // buttons act. The lock is requested on mouse *down*, the event browsers
  // reliably accept it from. Where locking can't work (an iPad trackpad, a
  // browser that refuses), the view follows the free cursor instead and
  // clicks act at the crosshair: nobody has to hold a button to look.
  let lockFails = 0;
  const lockFailed = () => {
    lockFails++;
    // One failure can be a browser's cool-down right after Escape; two in a
    // row means locking doesn't work here.
    if (lockFails >= 2 || !canvas.requestPointerLock) app.noLock = true;
  };
  const requestLock = () => {
    if (!canvas.requestPointerLock) return lockFailed();
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {}); // pointerlockerror counts it
    } catch {
      lockFailed();
    }
  };
  document.addEventListener("pointerlockerror", lockFailed);
  document.addEventListener("pointerlockchange", () => {
    app.locked = document.pointerLockElement === canvas;
    if (app.locked) {
      lockFails = 0;
      app.noLock = false;
    }
    releaseAll();
    document.body.classList.toggle("locked", app.locked);
  });
  document.addEventListener("mousemove", (e) => {
    if (app.locked || (app.noLock && !overlayOpen() && e.target === canvas)) app.player.look(e.movementX || 0, e.movementY || 0);
  });
  canvas.addEventListener("mousedown", (e) => {
    if (overlayOpen()) return;
    if (e.button === 1) e.preventDefault();
    if (app.locked) return act(e.button, true);
    // Not captured yet: capture. Where capture is known not to work, act now.
    if (app.noLock) act(e.button, true);
    requestLock();
  });
  document.addEventListener("mouseup", (e) => {
    if (e.button === 0) app.breakHeld = false;
    if (e.button === 2) app.placeHeld = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("auxclick", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    if (app.editor.active && e.deltaY) {
      app.editor.cycle(e.deltaY > 0 ? 1 : -1);
      hotbar();
    }
  }, { passive: true });

  // ---- Touch and pen: drag to look, tap to act ------------------------------
  // (The D-pad and buttons are in touch.js.) Playing, a tap fires blue and a
  // long press orange; building, a tap places and a long press breaks, as in
  // touch versions of block games.
  app.touch = new TouchControls($("hud"), app.player, {
    act,
    release: () => (app.placeHeld = app.breakHeld = false),
    shape: () => {
      app.editor.cycleShape(1);
      hotbar();
    },
    restart: () => app.player.respawn(app.world),
    clearRifts,
    building: () => app.editor.active,
    flying: () => app.player.flying,
  });
  if (window.matchMedia && matchMedia("(pointer: coarse)").matches) app.touch.enable();
  if (window.innerHeight < 600) $("legend").open = false; // small screens: start folded
  let drag = null; // the one finger currently turning the view
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || overlayOpen() || drag) return;
    app.touch.enable();
    hud();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    // A finger turns a little faster than a mouse, so a thumb-width swipe
    // is a useful turn on a small screen.
    app.player.look(dx * 1.6, dy * 1.6);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (e.type === "pointercancel" || d.moved > 12 || overlayOpen()) return; // a look, not a tap
    const long = performance.now() - d.t > 400;
    if (app.editor.active) act(long ? 0 : 2);
    else act(long ? 2 : 0);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ---- Keyboard ---------------------------------------------------------------
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
        clearRifts();
        break;
      case "KeyB":
        toggleBuild();
        break;
      case "Tab":
        // Hold for the player list, as in block games.
        e.preventDefault();
        showPlayerList(true);
        break;
      case "KeyF":
        if (app.editor.active) {
          app.editor.cycleShape(e.shiftKey ? -1 : 1);
          hotbar();
        }
        break;
      case "KeyM":
        openBrowser();
        break;
      case "KeyH":
        openHelp();
        break;
      case "F1":
        // Hide the HUD (and the hand), as in block games.
        e.preventDefault();
        document.body.classList.toggle("nohud");
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
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  });
  document.addEventListener("keyup", (e) => {
    app.player.keys.delete(e.code);
    if (e.code === "Tab") showPlayerList(false);
  });

  // SOLFRAY TIE-IN (guide section 10): when the frame loses focus, the tab is
  // hidden or pointer lock ends, the SDK fires solfray:inputreset; keyups
  // that happened meanwhile never arrive, so let go of everything.
  window.addEventListener("solfray:inputreset", releaseAll);
  window.addEventListener("blur", releaseAll);
}

/** Let go of every held key and button. */
function releaseAll() {
  app.player.clearKeys();
  app.placeHeld = app.breakHeld = false;
  if (app.touch) app.touch.releaseAll();
  showPlayerList(false);
}

function clearRifts() {
  if (app.net) app.net.event({ k: "clear" });
  else app.rifts.removeAll(myPk());
}

/** Tab (held): who is here, as in block games. */
function showPlayerList(on) {
  const el = $("playerlist");
  if (!el) return;
  if (!on) {
    el.hidden = true;
    return;
  }
  const ps = app.net ? app.net.participants : [{ pk: myPk(), display: "You", color: "#9aa0a6" }];
  el.innerHTML = `<div class="pl-title">${ps.length} player${ps.length === 1 ? "" : "s"}</div>` +
    ps.map((p) => `<div class="pl-row"><span class="dot" style="background:${esc(p.color || colorOf(p.pk))}"></span>${esc(p.display || short(p.pk))}${isMe(p.pk) ? " (you)" : ""}</div>`).join("");
  el.hidden = false;
}

/** A mouse button (0 left, 1 middle, 2 right) or the tap or touch button
 *  that stands in for one, aimed at the crosshair. `held` is true when a
 *  release will follow, so holding keeps breaking or placing. */
function act(button, held = false) {
  if (app.editor.active) {
    // Creative-mode mouse: left breaks, right places, middle picks.
    if (button === 0) {
      if (held) {
        app.breakHeld = true;
        app.breakTimer = BREAK_REPEAT;
      }
      if (app.editor.breakBlock()) app.dirty = true;
    }
    if (button === 2) {
      // Holding right click keeps placing, as in creative mode: walk
      // backward along an edge to lay a line of blocks.
      if (held) {
        app.placeHeld = true;
        app.placeTimer = PLACE_REPEAT;
      }
      if (app.editor.placeBlock()) app.dirty = true;
    }
    if (button === 1) {
      app.editor.pickBlock();
      hotbar();
    }
    hud();
  } else {
    if (button === 0) shoot("a");
    if (button === 2) shoot("b");
  }
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
    if (isTemplateMap(app.map.id)) {
      startFromTemplate(app.map.id);
      return;
    }
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
const PLACE_REPEAT = 0.2; // seconds between placements while right click is held
const BREAK_REPEAT = 0.25; // and between breaks while left click is held

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
  world.animate(performance.now());
  app.editor.update();

  // Buttons and doors are derived from where everyone stands, so every page
  // agrees without a host: a deterministic function of the poses it sees.
  const feet = [player.pos, ...app.avatars.positions()];
  world.setDoorsOpen(world.buttonsPressedBy(feet));

  if (app.touch) app.touch.sync();
  if (!overlayOpen() || app.editor.active) {
    // Arrow keys look around, for keyboards without a mouse (an iPad).
    const k = player.keys, rate = 2.4 * dt; // radians per second
    const turnX = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
    const turnY = (k.has("ArrowDown") ? 1 : 0) - (k.has("ArrowUp") ? 1 : 0);
    if (turnX || turnY) player.turn(turnX * rate, turnY * rate * 0.7);
    player.center(tmpPrev);
    world.passable = app.editor.active ? null : app.rifts.passable(tmpPrev);
    player.update(dt, world);
    world.passable = null;
    if (app.editor.active) {
      if (app.editor.rescueIfFallen()) toast("Fell off the build: back on the nearest block.");
      // Held buttons repeat, as in creative mode.
      if (app.placeHeld) {
        app.placeTimer -= dt;
        if (app.placeTimer <= 0) {
          app.placeTimer += PLACE_REPEAT;
          app.editor.update(); // aim from where the step just moved us
          if (app.editor.placeBlock()) {
            app.dirty = true;
            hud();
          }
        }
      }
      if (app.breakHeld) {
        app.breakTimer -= dt;
        if (app.breakTimer <= 0) {
          app.breakTimer += BREAK_REPEAT;
          app.editor.update();
          if (app.editor.breakBlock()) {
            app.dirty = true;
            hud();
          }
        }
      }
    } else {
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
  const hidden = document.body.classList.contains("nohud"); // F1
  app.gun.group.visible = !app.editor.active && !hidden;
  app.gun.animate(dt);
  if (app.editor.active && !hidden) app.held.setBlock(app.editor.tool === "block" ? app.editor.info : null);
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
  $("btn-save").onclick = () => (app.map && app.map.id && !isBuiltinMap(app.map.id) && app.map.mine ? save() : openSave());
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

// ---------------------------------------------------------------------------
// Controls: one table drives the build-mode Controls panel, the hint bar
// and Help, so they never disagree. Keys follow desktop block games; the
// touch column follows their touch editions.

const CONTROLS = {
  play: {
    keys: [
      ["W A S D", "Move"],
      ["Mouse", "Look (click the game first; Esc frees the mouse)"],
      ["Space", "Jump"],
      ["Shift", "Sneak (never off an edge)"],
      ["Ctrl / W W", "Sprint (or double-tap W)"],
      ["Left click", "Blue rift"],
      ["Right click", "Orange rift"],
      ["X", "Clear your rifts"],
      ["R", "Back to the start"],
      ["B", "Build mode (Start from this on a template)"],
      ["M", "Maps"],
      ["Tab (hold)", "Players"],
      ["H", "Help"],
      ["F1", "Hide the HUD"],
      ["Arrow keys", "Look (no mouse)"],
    ],
    touch: [
      ["D-pad", "Move (double-tap ▲ to sprint)"],
      ["Drag", "Look"],
      ["Tap · blue ◉", "Blue rift"],
      ["Hold · orange ◉", "Orange rift"],
      ["⤒", "Jump"],
      ["●", "Sneak on / off"],
      ["↺", "Back to the start"],
      ["✕", "Clear your rifts"],
      ["Build (top) / B", "Build mode (Start from this on a template)"],
    ],
  },
  build: {
    keys: [
      ["W A S D", "Move"],
      ["Mouse", "Look (click the game first; Esc frees the mouse)"],
      ["Space", "Jump · double-tap to fly"],
      ["Space / Shift", "Fly up / down (land with Shift)"],
      ["Shift", "Sneak (never off an edge)"],
      ["Ctrl / W W", "Sprint, fly fast"],
      ["Left click", "Break (hold to keep breaking)"],
      ["Right click", "Place (hold to keep placing)"],
      ["Middle click", "Pick the block you look at"],
      ["1–9 / wheel", "Choose a block"],
      ["0", "Spawn tool"],
      ["F / Shift+F", "Next / previous shape"],
      ["B", "Play mode"],
      ["M", "Maps"],
      ["Tab (hold)", "Players"],
      ["H", "Help"],
      ["F1", "Hide the HUD"],
      ["Arrow keys", "Look (no mouse)"],
    ],
    touch: [
      ["D-pad", "Move (double-tap ▲ to sprint)"],
      ["Drag", "Look"],
      ["Tap · ▣", "Place (hold ▣ to keep placing)"],
      ["Hold · ⛏", "Break (hold ⛏ to keep breaking)"],
      ["⤒", "Jump · double-tap to fly"],
      ["⤒ / ▼", "Fly up / down"],
      ["●", "Sneak on / off"],
      ["Hotbar", "Choose a block"],
      ["▦", "Next shape"],
      ["Play (top) / B", "Play mode"],
    ],
  },
};

function controlsTable(rows) {
  return `<table class="keys">${rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

/** The build-mode Controls panel: every control for this device. */
function legend() {
  const el = $("legend");
  const building = Boolean(app.editor && app.editor.active);
  el.hidden = !building;
  if (!building) return;
  const touch = document.body.classList.contains("touch");
  const key = touch ? "touch" : "keys";
  if (el.dataset.kind === key) return;
  el.dataset.kind = key;
  el.querySelector(".body").innerHTML = controlsTable(CONTROLS.build[key]);
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
  const onTemplate = Boolean(app.map && isTemplateMap(app.map.id) && !(app.editor && app.editor.active));
  $("btn-build").textContent = app.editor && app.editor.active ? "Play (B)" : onTemplate ? "Start from this" : "Build (B)";
  $("btn-build").disabled = !app.map;
  $("btn-save").disabled = !app.map;
  const owns = Boolean(app.map && app.map.id && !isBuiltinMap(app.map.id) && app.map.mine);
  $("btn-save").textContent = owns || (app.map && !app.map.id) ? "Save" : "Save as…";
  $("hotbar-wrap").hidden = !(app.editor && app.editor.active);
  $("hint").textContent = app.editor && app.editor.active
    ? "Every control is in the Controls panel · H help · F1 hide HUD · B play"
    : onTemplate
      ? "Template · B or Start from this makes a new map you can build on and save as yours · WASD · mouse look · Space jump · LMB/RMB rifts · M maps · Tab players · H help · F1 hide HUD"
      : "WASD move · mouse look · Space jump · Shift sneak · Ctrl / double-tap W sprint · LMB blue rift · RMB orange rift · X clear · R restart · B build · M maps · Tab players · H help · F1 hide HUD";
  legend();
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
  showOverlay(`<h2>Maps</h2><div class="tabs"><button data-scope="templates" class="sel">Templates</button><button data-scope="public">Public</button><button data-scope="mine">Mine</button></div>
    <div id="maplist" class="list">Loading…</div>
    <div class="row">
      <button id="ov-new">New map</button>
      <button id="ov-example">Example course</button>
      <button id="ov-starter">Starter yard</button>
      <span class="grow"></span>
      ${signinHtml()}
    </div>
    <p class="muted" id="identity-note">${identityNote()}</p>`);
  $("ov-new").onclick = newMap;
  $("ov-example").onclick = () => pickMap("example", "Example course");
  $("ov-starter").onclick = () => pickMap("starter", "Starter yard");
  wireSignin();
  const tabs = $("overlay-body").querySelectorAll(".tabs button");
  tabs.forEach((b) => (b.onclick = () => {
    tabs.forEach((x) => x.classList.toggle("sel", x === b));
    fillList(b.dataset.scope);
  }));
  fillList("templates");
}

async function fillList(scope) {
  const el = $("maplist");
  if (!el) return;
  if (scope === "templates") {
    el.classList.add("templates");
    const rows = listTemplateMaps()
      .map(
        (m) => `<div class="map" data-id="${esc(m.id)}">
          <div class="grow"><b>${esc(m.name)}</b> <span class="muted">template · ?map=${esc(m.id)}</span><br><span class="muted">${esc(m.description)}</span></div>
          <button data-act="play">Play</button>
          <button data-act="start" class="primary">Start from this</button>
        </div>`
      )
      .join("");
    el.innerHTML = `<p class="muted">Bases to build on, so you don't have to lay the terrain first. <b>Start from this</b> opens a new map in build mode; save it and it's yours. <b>Play</b> opens the shared original, which stays read-only.</p>${rows}`;
    el.querySelectorAll(".map").forEach((row) => {
      const id = row.dataset.id;
      const name = row.querySelector("b").textContent;
      row.querySelector('[data-act="play"]').onclick = () => pickMap(id, name);
      row.querySelector('[data-act="start"]').onclick = () => startFromTemplate(id);
    });
    return;
  }
  el.classList.remove("templates");
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
  const fresh = !app.map.id;
  const copy = !fresh && (isBuiltinMap(app.map.id) || !app.map.mine);
  const heading = fresh ? "Save your map" : copy ? "Save a copy" : "Save";
  showOverlay(`<h2>${heading}</h2>
    <label>Name <input id="sv-name" maxlength="48" value="${esc(copy ? app.map.name + " (copy)" : app.map.name)}"></label>
    <label>Description <textarea id="sv-desc" maxlength="300" rows="2">${esc(app.map.description || "")}</textarea></label>
    <label class="check"><input type="checkbox" id="sv-public" ${app.map.is_public ? "checked" : ""}> Public: list it for everyone</label>
    <div class="row"><button id="sv-ok" class="primary">${copy ? "Save copy" : "Save"}</button><button id="sv-cancel">Cancel</button></div>
    <p class="muted">Saved under <b>${esc(whoLabel())}</b>${app.sf.hosted ? " (your Solfray identity, proven to this server by a playable token)" : " (your Google account on this site)"}.</p>`);
  $("sv-cancel").onclick = closeOverlay;
  $("sv-ok").onclick = () => save({ name: $("sv-name").value.trim(), description: $("sv-desc").value.trim(), is_public: $("sv-public").checked, copy });
}

function openHelp() {
  showOverlay(`<h2>Rift Builder</h2>
    <p>Place two linked rifts on <b>light panels</b> (left click blue, right click orange), walk through one and come out of the other with your speed intact. Reach the green exit pad. Dark plates and glass refuse rifts; acid sends you back; a floor button held down by any player opens every door, so bring friends. The <b>Example course</b> (Maps, or <b>?map=example</b>) is a short solo run through every block.</p>
    <p>Stairs are slopes: a rift aimed at a two-step run sits on the slope, and a rift aimed at a floor or wall needs two panels of room.</p>
    <p><b>Templates</b> (Maps → Templates, or <b>?map=arena</b> and the other names listed there) are base terrains: an arena, canyons, a corner, a U-turn, pillars, terraces, a tower, a corridor. <b>Start from this</b> (or B while you are playing one) copies one into a new map and opens build mode. Save stores that copy under your account. Play leaves the shared original read-only.</p>
    <p><b>Build</b> (B) works like creative mode in block games. The ghost shows where the next block goes. Hold right click and walk backward off an edge while sneaking to lay a bridge. F cycles the shape: single block, 3×3 floor, 3×3 north–south wall, 3×3 east–west wall, 6-tall pillar (stairs always place singly). The spawn tool (0) puts the spawn on the block you right click. Stairs face the way you look; placed under a block they hang upside down. Fall far below the build and you land on the nearest block. Double-tap Space to fly (Space up, Shift down, Ctrl fast). Save as… stores the map on this server under your account; tick Public to list it.</p>
    <div class="cols">
      <div><h3>Playing</h3>${controlsTable(CONTROLS.play.keys)}<h3>Touch</h3>${controlsTable(CONTROLS.play.touch)}</div>
      <div><h3>Building</h3>${controlsTable(CONTROLS.build.keys)}<h3>Touch</h3>${controlsTable(CONTROLS.build.touch)}</div>
    </div>
    <p class="muted">No mouse capture (an iPad trackpad)? The view follows the cursor and clicks act at the crosshair; the arrow keys look around too. On a touchscreen, drag to look and use the buttons: tap for blue and hold for orange while playing; tap places and hold breaks while building.</p>
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
