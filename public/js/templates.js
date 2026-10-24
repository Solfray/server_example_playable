// Base map templates. Compact generators, not hand-placed cells: each one
// returns schema-1 map JSON (see src/api/maps.ts). Block numbers match
// BLOCK in world.js and src/api/maps.ts.
//
// Panels are the surfaces a rift should stick to (a wall facing the floor
// you want to land on, or a floor pad you want to pop up through). Plates
// are everything you walk on or that would dump a rift into the acid.
// Acid is the death floor. The exit pad is reachable in principle: a walk
// the long way, a plate-stair ramp, or a short bridge. These are bases to
// build on, not finished puzzles.
//
// A wall rift needs two panel cells stacked in the open; floor pads are at
// least 2×2 with air above them.

export const T = {
  PANEL: 1,
  PLATE: 2,
  EXIT: 3,
  ACID: 4,
  STAIR_PLATE: 9,
};

/** @returns {{ schema: 1, size: number[], spawn: number[], blocks: number[][] }} */
function createMap(id, size, spawn, build) {
  const [W, H, D] = size;
  const grid = new Map();
  const put = (x, y, z, t, m = 0) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
      throw new Error(`${id}: non-integer cell ${x},${y},${z}`);
    }
    if (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D) {
      throw new Error(`${id}: cell ${x},${y},${z} outside ${W}×${H}×${D}`);
    }
    grid.set(`${x},${y},${z}`, m ? [x, y, z, t, m] : [x, y, z, t]);
  };
  const fill = (x0, x1, y0, y1, z0, z1, t, m = 0) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) put(x, y, z, t, m);
      }
    }
  };
  // Plate stairs climbing +Z. `y` is the cell of the first low step (one
  // above the floor you are leaving). `steps` rises land on a floor
  // `steps + 1` cells higher than the floor under that first step.
  const rampPosZ = (x0, x1, y, z, steps) => {
    for (let i = 0; i < steps; i++) {
      for (let x = x0; x <= x1; x++) {
        const zLow = z + i * 2;
        for (let yy = 0; yy < y + i; yy++) {
          put(x, yy, zLow, T.PLATE);
          put(x, yy, zLow + 1, T.PLATE);
        }
        put(x, y + i, zLow, T.STAIR_PLATE, 0);
        put(x, y + i, zLow + 1, T.PLATE);
        put(x, y + i + 1, zLow + 1, T.STAIR_PLATE, 0);
      }
    }
  };
  // Same climb, toward -Z, so a stair can arrive at a ledge from the far side.
  const rampNegZ = (x0, x1, y, z, steps) => {
    for (let i = 0; i < steps; i++) {
      for (let x = x0; x <= x1; x++) {
        const zLow = z - i * 2;
        for (let yy = 0; yy < y + i; yy++) {
          put(x, yy, zLow, T.PLATE);
          put(x, yy, zLow - 1, T.PLATE);
        }
        put(x, y + i, zLow, T.STAIR_PLATE, 2);
        put(x, y + i, zLow - 1, T.PLATE);
        put(x, y + i + 1, zLow - 1, T.STAIR_PLATE, 2);
      }
    }
  };
  build({ put, fill, rampPosZ, rampNegZ, W, H, D });
  return { schema: 1, size: [W, H, D], spawn: spawn.slice(), blocks: [...grid.values()] };
}

// Flat yard. Acid pool in the middle, panel walls at the near and far ends
// (a rift between them crosses the pool), plate sides you can walk.
function arena() {
  return createMap("arena", [32, 8, 32], [15, 1, 5, 0], ({ fill, put }) => {
    fill(1, 30, 0, 0, 1, 30, T.PLATE);
    fill(10, 21, 0, 0, 12, 21, T.ACID);
    fill(1, 1, 1, 3, 2, 29, T.PLATE);
    fill(30, 30, 1, 3, 2, 29, T.PLATE);
    fill(1, 30, 1, 4, 1, 1, T.PANEL);
    fill(1, 30, 1, 4, 30, 30, T.PANEL);
    put(15, 1, 26, T.EXIT);
  });
}

// Two cliffs, same height, acid at the bottom of the gap. Panel walls sit
// at the back of each cliff, facing the floor, so a rift exits onto a cliff
// rather than into the gap. Cliff faces are plate.
function canyon() {
  return createMap("canyon", [26, 16, 36], [12, 8, 8, 0], ({ fill, put }) => {
    const deck = (z0, z1, faceZ0, faceZ1) => {
      fill(1, 24, 6, 7, z0, z1, T.PLATE);
      fill(1, 24, 0, 7, faceZ0, faceZ1, T.PLATE);
      fill(1, 1, 8, 9, z0, z1, T.PLATE);
      fill(24, 24, 8, 9, z0, z1, T.PLATE);
    };
    deck(1, 12, 11, 12);
    deck(23, 34, 23, 24);
    fill(1, 24, 0, 0, 13, 22, T.ACID);
    fill(4, 21, 8, 12, 1, 1, T.PANEL);
    fill(4, 21, 8, 12, 34, 34, T.PANEL);
    put(12, 8, 29, T.EXIT);
  });
}

// Same idea, but the far cliff is much higher. The landing is a panel pad
// set into the high floor (a floor rift pops you up onto it). The tall face
// stays plate so a rift there does not throw you back into the acid.
function highCanyon() {
  return createMap("high-canyon", [24, 22, 38], [11, 5, 7, 0], ({ fill, put }) => {
    fill(1, 22, 3, 4, 1, 11, T.PLATE);
    fill(1, 22, 0, 4, 10, 11, T.PLATE);
    fill(1, 1, 5, 6, 1, 11, T.PLATE);
    fill(22, 22, 5, 6, 1, 11, T.PLATE);
    fill(4, 19, 5, 9, 1, 1, T.PANEL);

    fill(1, 22, 0, 0, 12, 22, T.ACID);

    fill(1, 22, 13, 14, 23, 36, T.PLATE);
    fill(1, 22, 0, 14, 23, 24, T.PLATE);
    fill(1, 2, 0, 14, 23, 36, T.PLATE);
    fill(21, 22, 0, 14, 23, 36, T.PLATE);
    fill(7, 16, 14, 14, 25, 29, T.PANEL);
    fill(5, 18, 15, 19, 36, 36, T.PANEL);
    put(11, 15, 33, T.EXIT);
  });
}

// An L of plate corridor. The inside of the turn is acid, so cutting the
// corner drops you. Panel walls face down each leg (behind the spawn, and
// at the far end of the turn).
function corner() {
  return createMap("corner", [32, 8, 30], [6, 1, 4, 0], ({ fill, put }) => {
    // Inside of the turn, then the L (floors run under the walls so nothing floats).
    fill(16, 29, 0, 0, 2, 14, T.ACID);
    fill(1, 14, 0, 0, 1, 27, T.PLATE);
    fill(15, 28, 0, 0, 16, 27, T.PLATE);
    fill(15, 30, 0, 0, 1, 1, T.PLATE);
    fill(30, 30, 0, 0, 1, 15, T.PLATE);
    fill(1, 1, 1, 4, 1, 27, T.PLATE);
    fill(15, 15, 1, 3, 2, 15, T.PLATE);
    fill(16, 30, 1, 3, 1, 1, T.PLATE);
    fill(30, 30, 1, 3, 1, 15, T.PLATE);
    fill(2, 14, 1, 4, 1, 1, T.PANEL);
    fill(2, 14, 1, 4, 27, 27, T.PANEL);
    fill(28, 28, 1, 4, 16, 26, T.PANEL);
    put(24, 1, 21, T.EXIT);
  });
}

// Walk east, around the bend, and back west. The channel in the middle is
// acid. A one-block curb lets you see over it; panel columns on the curb
// face the walkway (tall enough for a rift) so a pair can skip the U.
function uTurn() {
  return createMap("u-turn", [40, 8, 22], [6, 1, 4, Math.PI / 2], ({ fill, put }) => {
    fill(1, 37, 0, 0, 1, 1, T.PLATE);
    fill(1, 37, 0, 0, 20, 20, T.PLATE);
    fill(1, 1, 0, 0, 1, 20, T.PLATE);
    fill(37, 37, 0, 0, 1, 20, T.PLATE);
    fill(2, 36, 0, 0, 2, 6, T.PLATE);
    fill(2, 36, 0, 0, 15, 19, T.PLATE);
    fill(28, 36, 0, 0, 2, 19, T.PLATE);
    fill(2, 27, 0, 0, 7, 7, T.PLATE);
    fill(2, 27, 0, 0, 14, 14, T.PLATE);
    fill(2, 27, 1, 1, 7, 7, T.PLATE);
    fill(2, 27, 1, 1, 14, 14, T.PLATE);
    fill(2, 27, 0, 0, 8, 13, T.ACID);
    fill(1, 1, 1, 3, 1, 20, T.PLATE);
    fill(37, 37, 1, 3, 1, 20, T.PLATE);
    fill(1, 37, 1, 3, 1, 1, T.PLATE);
    fill(1, 37, 1, 3, 20, 20, T.PLATE);
    for (const x of [4, 12, 20]) {
      fill(x, x + 1, 1, 4, 7, 7, T.PANEL);
      fill(x, x + 1, 1, 4, 14, 14, T.PANEL);
    }
    put(8, 1, 17, T.EXIT);
  });
}

// Islands and pillars standing in acid. Each pillar's far edge is a panel
// wall facing back toward the approach, so a rift there exits onto the top
// rather than off it.
function pillars() {
  return createMap("pillars", [28, 14, 40], [13, 5, 5, 0], ({ fill, put }) => {
    fill(0, 27, 0, 0, 0, 39, T.ACID);
    fill(8, 19, 1, 4, 1, 9, T.PLATE);
    fill(10, 17, 5, 8, 1, 1, T.PANEL);
    const pillar = (x, z, top) => {
      fill(x, x + 2, 1, top, z, z + 2, T.PLATE);
      fill(x, x + 2, top + 1, top + 3, z + 2, z + 2, T.PANEL);
    };
    pillar(11, 13, 4);
    pillar(17, 19, 7);
    pillar(8, 25, 5);
    pillar(16, 30, 8);
    fill(8, 19, 1, 6, 36, 39, T.PLATE);
    fill(10, 17, 7, 10, 39, 39, T.PANEL);
    put(13, 7, 37, T.EXIT);
  });
}

// Three plate terraces stepping up, acid in the gaps, a panel pad on each
// upper landing, and a plate-stair ramp along the west side.
function terraces() {
  return createMap("terraces", [24, 14, 36], [12, 3, 6, 0], ({ fill, put, rampPosZ }) => {
    const terrace = (y, z0, z1) => {
      fill(5, 21, 0, y, z0, z1, T.PLATE);
    };
    terrace(2, 1, 8);
    terrace(5, 13, 19);
    terrace(8, 24, 34);
    fill(6, 22, 0, 0, 9, 12, T.ACID);
    fill(6, 22, 0, 0, 20, 23, T.ACID);
    // Landings that join the ramp to each terrace.
    fill(1, 6, 0, 2, 6, 8, T.PLATE);
    fill(1, 6, 0, 5, 12, 13, T.PLATE);
    fill(1, 6, 0, 8, 23, 24, T.PLATE);
    rampPosZ(1, 2, 3, 9, 2);
    rampPosZ(1, 2, 6, 20, 2);
    fill(8, 16, 3, 6, 1, 1, T.PANEL);
    fill(10, 15, 5, 5, 14, 17, T.PANEL);
    fill(10, 15, 8, 8, 25, 28, T.PANEL);
    fill(8, 16, 9, 12, 34, 34, T.PANEL);
    put(12, 9, 31, T.EXIT);
  });
}

// A tower in an acid moat. The roof has a panel pad beside the exit. Plate
// stairs climb the north side (off the spawn view) from a path around the east.
function tower() {
  return createMap("tower", [30, 14, 38], [14, 3, 5, 0], ({ fill, put, rampNegZ }) => {
    fill(0, 29, 0, 0, 0, 37, T.ACID);
    fill(7, 22, 0, 2, 1, 10, T.PLATE);
    fill(10, 18, 3, 7, 1, 1, T.PANEL);
    fill(11, 18, 0, 9, 14, 21, T.PLATE);
    fill(13, 16, 9, 9, 16, 19, T.PANEL);
    put(14, 10, 20, T.EXIT);
    // East path around the moat to the foot of the north stairs.
    fill(23, 25, 0, 2, 6, 33, T.PLATE);
    fill(14, 25, 0, 2, 31, 33, T.PLATE);
    rampNegZ(14, 15, 3, 33, 6);
  });
}

// A straight corridor. Acid pits flank the path, and two trenches cut
// across it with a two-block plate bridge left in. Panel walls face the
// path on either side of each trench.
function corridor() {
  return createMap("corridor", [18, 8, 42], [8, 1, 3, 0], ({ fill, put }) => {
    fill(0, 17, 0, 0, 0, 0, T.PLATE);
    fill(0, 17, 0, 0, 41, 41, T.PLATE);
    fill(0, 0, 0, 0, 0, 41, T.PLATE);
    fill(17, 17, 0, 0, 0, 41, T.PLATE);
    fill(0, 17, 1, 3, 0, 0, T.PLATE);
    fill(0, 17, 1, 3, 41, 41, T.PLATE);
    fill(0, 0, 1, 3, 0, 41, T.PLATE);
    fill(17, 17, 1, 3, 0, 41, T.PLATE);
    fill(4, 13, 0, 0, 1, 40, T.PLATE);
    fill(1, 3, 0, 0, 1, 40, T.ACID);
    fill(14, 16, 0, 0, 1, 40, T.ACID);
    // Side pits read as openings: drop the inner wall for those stretches
    // by leaving the acid where it is and not adding a lip. The path edge
    // is the plate at x=4 and x=13.
    const trench = (z0, z1) => {
      fill(4, 13, 0, 0, z0, z1, T.ACID);
      fill(7, 8, 0, 0, z0, z1, T.PLATE);
      fill(4, 4, 1, 4, z0 - 1, z1 + 1, T.PANEL);
      fill(13, 13, 1, 4, z0 - 1, z1 + 1, T.PANEL);
    };
    trench(16, 19);
    trench(30, 33);
    fill(5, 12, 1, 4, 1, 1, T.PANEL);
    fill(5, 12, 1, 4, 40, 40, T.PANEL);
    put(8, 1, 37, T.EXIT);
  });
}

/** In menu order. `id` is the `?map=` value. */
export const TEMPLATES = [
  {
    id: "arena",
    name: "Acid arena",
    description: "A flat plate arena with an acid pool in the middle. Panel walls at each end take a rift across; the sides are a walk.",
    build: arena,
  },
  {
    id: "canyon",
    name: "Deep canyon",
    description: "Two plate cliffs with a deep acid-floored gap between them. Panel walls face onto each cliff so a rift can cross.",
    build: canyon,
  },
  {
    id: "high-canyon",
    name: "High canyon",
    description: "A deep acid canyon whose far cliff is much higher. A panel pad on the high floor is the landing; the cliff face is plate.",
    build: highCanyon,
  },
  {
    id: "corner",
    name: "Corner",
    description: "A plate L around a 90° acid corner. Panel walls face down each leg so a rift can cut the corner.",
    build: corner,
  },
  {
    id: "u-turn",
    name: "U-turn",
    description: "A U-shaped plate detour around a long acid channel. Panel columns on the inner curb face the walkway.",
    build: uTurn,
  },
  {
    id: "pillars",
    name: "Pillar field",
    description: "Plate pillars over an acid sea, each with a panel wall facing back along the route, and an exit island at the far end.",
    build: pillars,
  },
  {
    id: "terraces",
    name: "Terraces",
    description: "Plate terraces stepping up across acid gaps, panel pads on the landings, and a plate-stair ramp up the side.",
    build: terraces,
  },
  {
    id: "tower",
    name: "Central tower",
    description: "A plate tower in an acid moat, a panel pad on the roof by the exit, and plate stairs up the back.",
    build: tower,
  },
  {
    id: "corridor",
    name: "Pit corridor",
    description: "A long plate corridor with acid pits on the sides and two acid trenches. A narrow bridge and panel walls sit at each trench.",
    build: corridor,
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function isTemplateId(id) {
  return BY_ID.has(id);
}

/** Id, name, and description only (no block generation). */
export function templateCatalog() {
  return TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
}

export function templateById(id) {
  const t = BY_ID.get(id);
  if (!t) return null;
  return { id: t.id, name: t.name, description: t.description, data: t.build() };
}

export function listTemplates() {
  return TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, data: t.build() }));
}
