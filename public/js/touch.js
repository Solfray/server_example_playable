// touch.js: on-screen controls for players with only a touchscreen, laid out
// the way touch players of block games already know them:
//
//   bottom left    D-pad: forward / back / strafe (slide between arrows;
//                  diagonals work), double tap forward to sprint, the
//                  centre button toggles sneak
//   bottom right   Jump (double tap it in build mode to fly); while flying
//                  it climbs and a second button descends
//                  playing: blue rift / orange rift buttons
//                  building: Place / Break (hold either to repeat), Shape
//   anywhere else  drag to look, tap to act at the crosshair (app.js)
//
// The D-pad and buttons feed the same key codes as the keyboard (KeyW,
// Space, ShiftLeft...) into player.keys, so the player controller has one
// input path. Only the codes this module pressed are released by it, so a
// physical keyboard (an iPad's) keeps working alongside.

const MANAGED = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft"];

export class TouchControls {
  /** `hooks`: { act(button, held), release(), shape(), restart(), clearRifts(),
   *  building(), flying() } */
  constructor(root, player, hooks) {
    this.player = player;
    this.hooks = hooks;
    this.held = new Set(); // codes held by touch right now
    this.pressedByUs = new Set(); // codes we put into player.keys
    this.sneakLatched = false;
    this.enabled = false;

    this.el = document.createElement("div");
    this.el.id = "touch";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="dpad" aria-label="Move">
        <span class="arrow up">▲</span><span class="arrow left">◀</span>
        <span class="arrow right">▶</span><span class="arrow down">▼</span>
        <button class="tbtn sneak" data-role="sneak" title="Sneak">●</button>
      </div>
      <div class="tside">
        <div class="trow" data-show="play">
          <button class="tbtn small" data-role="restart" title="Restart (R)">↺</button>
          <button class="tbtn small" data-role="clear" title="Clear rifts (X)">✕</button>
        </div>
        <div class="trow" data-show="play">
          <button class="tbtn act blue" data-role="act0" title="Blue rift">◉</button>
          <button class="tbtn act orange" data-role="act2" title="Orange rift">◉</button>
        </div>
        <div class="trow" data-show="build">
          <button class="tbtn small" data-role="shape" title="Shape (F)">▦</button>
          <button class="tbtn act" data-role="break" title="Break (hold to repeat)">⛏</button>
          <button class="tbtn act" data-role="place" title="Place (hold to repeat)">▣</button>
        </div>
        <div class="trow">
          <button class="tbtn fly" data-role="down" data-show="fly" title="Fly down">▼</button>
          <button class="tbtn jump" data-role="jump" title="Jump · double tap to fly in build mode">⤒</button>
        </div>
      </div>`;
    root.appendChild(this.el);

    this.wireDpad(this.el.querySelector(".dpad"));
    for (const b of this.el.querySelectorAll("button[data-role]")) this.wireButton(b);
  }

  /** Show the controls (first touch, or a coarse-pointer device at boot). */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.el.hidden = false;
    document.body.classList.add("touch");
  }

  wireDpad(pad) {
    let id = null;
    const set = (e) => {
      const r = pad.getBoundingClientRect();
      const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const want = new Set();
      if (ny < -0.35) want.add("KeyW");
      if (ny > 0.35) want.add("KeyS");
      if (nx < -0.35) want.add("KeyA");
      if (nx > 0.35) want.add("KeyD");
      for (const k of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
        if (want.has(k) && !this.held.has(k)) {
          this.held.add(k);
          this.player.keyPressed(k, performance.now()); // double tap forward sprints
        } else if (!want.has(k)) this.held.delete(k);
      }
      pad.classList.toggle("w", want.has("KeyW"));
      pad.classList.toggle("s", want.has("KeyS"));
      pad.classList.toggle("a", want.has("KeyA"));
      pad.classList.toggle("d", want.has("KeyD"));
    };
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      for (const k of ["KeyW", "KeyA", "KeyS", "KeyD"]) this.held.delete(k);
      pad.classList.remove("w", "a", "s", "d");
    };
    pad.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || id !== null) return;
      e.preventDefault();
      id = e.pointerId;
      try {
        pad.setPointerCapture(id);
      } catch {}
      set(e);
    });
    pad.addEventListener("pointermove", (e) => {
      if (e.pointerId === id) set(e);
    });
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
  }

  wireButton(b) {
    const role = b.dataset.role;
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {}
      b.classList.add("on");
      switch (role) {
        case "jump":
          this.held.add("Space");
          this.player.keyPressed("Space", performance.now()); // double tap: fly
          break;
        case "down":
          this.held.add("ShiftLeft");
          break;
        case "sneak":
          this.sneakLatched = !this.sneakLatched;
          break;
        case "act0":
          this.hooks.act(0, false);
          break;
        case "act2":
          this.hooks.act(2, false);
          break;
        case "place":
          this.hooks.act(2, true);
          break;
        case "break":
          this.hooks.act(0, true);
          break;
        case "shape":
          this.hooks.shape();
          break;
        case "restart":
          this.hooks.restart();
          break;
        case "clear":
          this.hooks.clearRifts();
          break;
      }
    };
    const up = () => {
      b.classList.remove("on");
      if (role === "jump") this.held.delete("Space");
      if (role === "down") this.held.delete("ShiftLeft");
      if (role === "place" || role === "break") this.hooks.release();
    };
    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Let go of everything (focus lost, overlay opened, inputreset). */
  releaseAll() {
    this.held.clear();
    this.sneakLatched = false;
    for (const b of this.el.querySelectorAll(".on")) b.classList.remove("on");
    this.el.querySelector(".dpad").classList.remove("w", "a", "s", "d");
    this.sync();
  }

  /** Every frame: mirror touch state into player.keys, and show the buttons
   *  that fit the mode (playing / building / flying). */
  sync() {
    if (!this.enabled) return;
    const flying = this.hooks.flying();
    if (flying) this.sneakLatched = false; // in the air the down button is sneak
    const want = new Set(this.held);
    if (this.sneakLatched) want.add("ShiftLeft");
    for (const k of MANAGED) {
      if (want.has(k)) {
        this.player.keys.add(k);
        this.pressedByUs.add(k);
      } else if (this.pressedByUs.has(k)) {
        this.player.keys.delete(k);
        this.pressedByUs.delete(k);
      }
    }
    const building = this.hooks.building();
    this.el.classList.toggle("building", building);
    this.el.classList.toggle("flying", flying);
    this.el.querySelector(".sneak").classList.toggle("on", this.sneakLatched);
    for (const n of this.el.querySelectorAll("[data-show]")) {
      const s = n.dataset.show;
      n.hidden = s === "play" ? building : s === "build" ? !building : s === "fly" ? !flying : false;
    }
  }
}
