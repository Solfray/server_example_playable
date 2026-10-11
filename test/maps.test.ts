import { describe, expect, it } from "vitest";
import { BLOCK, MAP_LIMITS, validateMap } from "../src/api/maps";

const good = () => ({
  schema: 1,
  size: [8, 4, 8],
  spawn: [2, 1, 2, 0],
  blocks: [
    [0, 0, 0, BLOCK.PANEL],
    [1, 0, 0, BLOCK.STEEL],
    [7, 3, 7, BLOCK.GOAL],
  ],
});

describe("map validation", () => {
  it("accepts a well-formed map and strips unknown fields", () => {
    const r = validateMap({ ...good(), owner_id: "solfray:attacker", extra: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual(["blocks", "schema", "size", "spawn"]);
      expect(r.data.blocks).toHaveLength(3);
    }
  });

  it("refuses blocks outside the grid, unknown types, and bad sizes", () => {
    expect(validateMap({ ...good(), blocks: [[8, 0, 0, 1]] })).toEqual({ ok: false, field: "blocks" });
    expect(validateMap({ ...good(), blocks: [[0, 0, 0, 99]] })).toEqual({ ok: false, field: "blocks" });
    expect(validateMap({ ...good(), blocks: [[0.5, 0, 0, 1]] })).toEqual({ ok: false, field: "blocks" });
    expect(validateMap({ ...good(), size: [3, 4, 8] })).toEqual({ ok: false, field: "size" });
    expect(validateMap({ ...good(), size: [MAP_LIMITS.maxSize + 1, 4, 8] })).toEqual({ ok: false, field: "size" });
    expect(validateMap({ ...good(), spawn: [99, 1, 2, 0] })).toEqual({ ok: false, field: "spawn" });
    expect(validateMap({ ...good(), schema: 2 })).toEqual({ ok: false, field: "schema" });
    expect(validateMap(null)).toEqual({ ok: false, field: "root" });
  });

  it("drops duplicate cells, keeping the first", () => {
    const r = validateMap({ ...good(), blocks: [[0, 0, 0, BLOCK.PANEL], [0, 0, 0, BLOCK.STEEL]] });
    expect(r.ok && r.data.blocks).toEqual([[0, 0, 0, BLOCK.PANEL]]);
  });

  it("accepts stair meta only on stairs, 0..7, and normalises meta 0 away", () => {
    const r = validateMap({ ...good(), blocks: [[0, 0, 0, BLOCK.STAIR, 5], [1, 0, 0, BLOCK.STAIR_STEEL, 0], [2, 0, 0, BLOCK.PANEL]] });
    expect(r.ok && r.data.blocks).toEqual([[0, 0, 0, BLOCK.STAIR, 5], [1, 0, 0, BLOCK.STAIR_STEEL], [2, 0, 0, BLOCK.PANEL]]);
    expect(validateMap({ ...good(), blocks: [[0, 0, 0, BLOCK.PANEL, 1]] })).toEqual({ ok: false, field: "blocks" });
    expect(validateMap({ ...good(), blocks: [[0, 0, 0, BLOCK.STAIR, 8]] })).toEqual({ ok: false, field: "blocks" });
    expect(validateMap({ ...good(), blocks: [[0, 0, 0, BLOCK.STAIR, 1.5]] })).toEqual({ ok: false, field: "blocks" });
    expect(validateMap({ ...good(), blocks: [[0, 0, 0, BLOCK.STAIR, 1, 1]] })).toEqual({ ok: false, field: "blocks" });
  });

  it("caps the block count", () => {
    const blocks = [];
    for (let i = 0; i < MAP_LIMITS.maxBlocks + 1; i++) blocks.push([i % 64, Math.floor(i / 64) % 64, 0, 1]);
    expect(validateMap({ ...good(), size: [64, 64, 64], blocks })).toEqual({ ok: false, field: "blocks" });
  });
});
