import { describe, expect, it } from "vitest";
import { BLOCK, MAP_LIMITS, validateMap, type MapData } from "../src/api/maps";
// Plain JS shared with the page (public/js/templates.js). No declaration file;
// vitest loads the module, and this comment keeps tsc quiet about it.
// @ts-expect-error templates.js is an untyped browser module
import { listTemplates } from "../public/js/templates.js";

interface Template {
  id: string;
  name: string;
  description: string;
  data: MapData;
}

const EXPECTED = ["arena", "canyon", "high-canyon", "corner", "u-turn", "pillars", "terraces", "tower", "corridor"];

function cellAt(data: MapData, x: number, y: number, z: number) {
  return data.blocks.find((b) => b[0] === x && b[1] === y && b[2] === z);
}

describe("base map templates", () => {
  const templates = listTemplates() as Template[];

  it("lists the templates in menu order, with url-safe ids", () => {
    expect(templates.map((t) => t.id)).toEqual(EXPECTED);
    for (const t of templates) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.name.length).toBeLessThanOrEqual(MAP_LIMITS.nameMax);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThanOrEqual(MAP_LIMITS.descMax);
    }
  });

  it.each(templates)("$id passes map validation and the template rules", (t) => {
    const check = validateMap(t.data);
    expect(check.ok, check.ok ? "" : check.field).toBe(true);
    if (!check.ok) return;
    const data = check.data;
    const json = JSON.stringify(data);
    expect(json.length, `${t.id} is ${json.length} bytes`).toBeLessThanOrEqual(MAP_LIMITS.maxBytes);
    expect(data.blocks.length, `${t.id} has ${data.blocks.length} blocks`).toBeLessThanOrEqual(MAP_LIMITS.maxBlocks);
    expect(data.blocks.length).toBeGreaterThan(10);

    const types = new Set(data.blocks.map((b) => b[3]));
    expect(types.has(BLOCK.PANEL), "panels where rifts should stick").toBe(true);
    expect(types.has(BLOCK.STEEL), "plates where rifts should not").toBe(true);
    expect(types.has(BLOCK.HAZARD), "acid death floor").toBe(true);
    expect(types.has(BLOCK.GOAL), "exit pad").toBe(true);

    const [sx, sy, sz] = data.spawn.map(Math.floor) as [number, number, number];
    const floor = cellAt(data, sx, sy - 1, sz);
    expect(floor, "spawn stands on a block").toBeTruthy();
    expect(floor && floor[3]).not.toBe(BLOCK.HAZARD);
    expect(cellAt(data, sx, sy, sz), "spawn cell is air").toBeUndefined();
    expect(cellAt(data, sx, sy + 1, sz), "headroom above spawn").toBeUndefined();

    const goal = data.blocks.find((b) => b[3] === BLOCK.GOAL);
    expect(goal).toBeTruthy();
    if (!goal) return;
    const [gx, gy, gz] = goal;
    expect(cellAt(data, gx, gy + 1, gz), "air above the exit pad").toBeUndefined();
    const approach = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dz]) => !cellAt(data, gx + dx, gy, gz + dz));
    expect(approach, "the exit is not sealed in").toBe(true);
  });

  it("gives the climbs plate stairs, which do not take rifts", () => {
    const byId = new Map(templates.map((t) => [t.id, t]));
    for (const id of ["terraces", "tower"]) {
      const t = byId.get(id);
      expect(t).toBeTruthy();
      const stairs = t!.data.blocks.filter((b) => b[3] === BLOCK.STAIR_STEEL);
      expect(stairs.length).toBeGreaterThan(0);
      expect(t!.data.blocks.some((b) => b[3] === BLOCK.STAIR)).toBe(false);
    }
  });
});
