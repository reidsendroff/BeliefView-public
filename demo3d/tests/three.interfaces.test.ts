import { describe, it, expect } from "vitest";
import { EvidenceLedger } from "../src/team/evidence";
import { ThreeEstimate } from "../src/team/threeEstimate";
import {
  threeNoise,
  buildThreePublicScenario,
  generateThreeScenario,
} from "../src/team/threeScenario";
import { unionMass, angularGaps } from "../src/team/threeUnion";
import { Rng } from "../src/sim/rng";
import type { Evidence, SensorId } from "../src/team/types";
const packet = (id: SensorId, x = 0, t = 0): Evidence => ({
  sensorId: id,
  messageId: String(t),
  sensedAt: t,
  receivedAt: t,
  pose: { x: 0, y: 3, z: 20, yaw: Math.PI, pitch: 0 },
  observation: { x, z: 0, t, sigma: 1 },
});
describe("three-drone interfaces", () => {
  it("accepts C only in explicitly configured cohorts and rejects malformed cohorts", () => {
    expect(new EvidenceLedger().accept([packet("C")], 0)).toEqual([]);
    expect(
      new EvidenceLedger(["A", "B", "C"]).accept([packet("C")], 0),
    ).toHaveLength(1);
    expect(() => new EvidenceLedger(["A", "A"])).toThrow();
    expect(() => new EvidenceLedger(["D" as SensorId])).toThrow();
  });
  it("gives C a distinct reproducible noise stream", () => {
    for (let i = 0; i < 20; i++) {
      const a = threeNoise(225016, i, "A"),
        b = threeNoise(225016, i, "B"),
        c = threeNoise(225016, i, "C");
      expect(c).not.toEqual(a);
      expect(c).not.toEqual(b);
      expect(c).toEqual(threeNoise(225016, i, "C"));
    }
  });
  it("keeps the original public A/B starts while adding a known-map C start", () => {
    const p = buildThreePublicScenario(220016, "rich");
    expect(p.starts.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(p.starts.slice(0, 2)).toEqual([
      { id: "A", x: -42, z: 56 },
      { id: "B", x: 42, z: 56 },
    ]);
    expect(p.starts[2].z).toBeLessThan(-40);
  });
  it("guards reserved seeds before creating any three-drone world", () => {
    expect(() => buildThreePublicScenario(320000, "rich")).toThrow();
    expect(() => generateThreeScenario(220000, 325000, "rich")).toThrow();
    expect(() => buildThreePublicScenario(320000 + 2 ** 32, "rich")).toThrow();
  });
  it("fuses a consistent majority instead of a fresh isolated outlier, with source-order invariance", () => {
    const packets = [
      packet("A", 0, 0),
      packet("B", 2, 0),
      packet("C", 80, 0.5),
    ];
    const run = (a: Evidence[]) =>
      new ThreeEstimate().update(a, 0.5, { vx: 0, vz: 0 });
    const e = run(packets)!;
    expect(e.sources.map((s) => s.id)).toEqual(["A", "B"]);
    expect(e.x).toBeCloseTo(1);
    expect(e.excluded).toEqual([{ id: "C", reason: "inconsistent" }]);
    expect(run([...packets].reverse())).toEqual(e);
  });
  it("expires public reports and ignores forbidden truth properties", () => {
    const e = packet("C");
    for (const key of ["subject", "hidden", "visibility", "posture"])
      Object.defineProperty(e, key, {
        enumerable: true,
        get() {
          throw Error("truth accessed");
        },
      });
    const f = new ThreeEstimate();
    expect(f.update([e], 0, { vx: 0, vz: 0 })!.sources[0].id).toBe("C");
    expect(f.update([], 3.05, { vx: 0, vz: 0 })).toBeNull();
  });
  it("matches brute-force ten-sample union including triple overlap", () => {
    const rng = new Rng(913),
      p = Float64Array.from([0.1, 0.2, 0.3, 0.4]);
    for (let trial = 0; trial < 30; trial++) {
      const masks = Array.from({ length: 3 }, () =>
        Uint16Array.from({ length: 4 }, () => Math.floor(rng.next() * 1024)),
      );
      let oracle = 0;
      for (let k = 0; k < 4; k++)
        for (let b = 0; b < 10; b++)
          if (masks.some((m) => m[k] & (1 << b))) oracle += p[k] / 10;
      expect(unionMass(p, masks)).toBeCloseTo(oracle, 12);
    }
    const m = new Uint16Array([1023]);
    expect(unionMass([1], [m, m, m])).toBe(1);
  });
  it("measures all three circular angular gaps", () => {
    const points = [0, 120, 240].map((d) => ({
      x: 16 * Math.cos((d * Math.PI) / 180),
      z: 16 * Math.sin((d * Math.PI) / 180),
    }));
    for (const g of angularGaps(points, { x: 0, z: 0 }))
      expect(g).toBeCloseTo(120);
  });
});
