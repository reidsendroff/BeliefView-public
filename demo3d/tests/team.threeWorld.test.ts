import { describe, it, expect } from "vitest";
import { buildRichWorld } from "../src/sim/richWorld";
import { DEFAULT_CONFIG, buildWorld } from "../src/sim/simulate";
import {
  buildThreeRichWorld,
  wrapThreeOriginalWorld,
  makeLog,
  FOREST,
} from "../src/team/threeWorld";
import { segmentHitsConvex } from "../src/team/threeGeometry";
describe("N3 public physical forest", () => {
  it("keeps heightAt identical and replaces rather than duplicates convex cover", () => {
    const base = buildRichWorld({ ...DEFAULT_CONFIG, seed: 220016 }),
      before = JSON.stringify(base),
      w = buildThreeRichWorld(220016, base);
    expect(w.heightAt).toBe(base.heightAt);
    expect(JSON.stringify(base)).toBe(before);
    expect(w.n3Solids.filter((s) => s.kind === "boulder")).toHaveLength(
      FOREST.largeBoulders,
    );
    expect(w.covers.some((c) => c.kind === "log")).toBe(false);
    expect(w.n3Solids.some((s) => s.kind === "log")).toBe(true);
    for (const cover of w.n3Covers) {
      for (const i of cover.treeIndices) expect(w.trees[i]).toBeDefined();
      for (const id of cover.solidIds)
        expect(w.n3Solids.some((s) => s.id === id)).toBe(true);
    }
    expect(JSON.stringify(buildThreeRichWorld(220016))).toBe(JSON.stringify(w));
  });
  it("uses exact closed log faces without sampled-sphere waists", () => {
    const s = makeLog("fixture", 0, 0, 0, 0.65, 5, 0);
    expect(s.faces).toHaveLength(12);
    for (const v of s.vertices)
      for (const p of s.planes)
        expect(
          p.normal.x * v.x + p.normal.y * v.y + p.normal.z * v.z,
        ).toBeLessThanOrEqual(p.offset + 1e-6);
    for (let z = -2.4; z <= 2.4; z += 0.2)
      expect(
        segmentHitsConvex(s, { x: -2, y: 0.5, z }, { x: 2, y: 0.5, z }),
      ).toBe(true);
    expect(
      segmentHitsConvex(s, { x: -2, y: 0.5, z: 2.8 }, { x: 2, y: 0.5, z: 2.8 }),
    ).toBe(false);
  });
  it("wraps original geometry without changing old source objects", () => {
    const old = buildWorld({ ...DEFAULT_CONFIG, seed: 220016 }),
      w = wrapThreeOriginalWorld(old);
    expect(w.trees).toBe(old.trees);
    expect(w.heightAt).toBe(old.heightAt);
    expect(w.n3Solids).toEqual([]);
  });
});
