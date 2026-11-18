import { describe, it, expect } from "vitest";
import { TeamMap, fraction } from "../src/team/map";
import { TeamBelief } from "../src/team/belief";
import { EvidenceLedger } from "../src/team/evidence";
import { INITIAL_REGION, type Evidence } from "../src/team/types";
import {
  buildPublicScenario,
  generateTeamScenario,
  initialDrones,
  canSense,
  makeSubject,
  nearestDrone,
} from "../src/team/scenario";
import { observationMetrics, simulateTeam } from "../src/team/runtime";
import { TeamPlanner } from "../src/team/planner";
import { enforceSeparation, sweptSeparation } from "../src/team/separation";
import { makeDrone } from "../src/sim/drone";
import type { World } from "../src/sim/world";
const flat: World = {
  seed: 1,
  half: 95,
  trees: [],
  rocks: [],
  heightAt: () => 0,
};
const packet = (id: "A" | "B" = "A", t = 1): Evidence => ({
  messageId: String(t),
  sensorId: id,
  sensedAt: t,
  receivedAt: t,
  pose: { x: 0, y: 3, z: -12, yaw: 0, pitch: -0.1 },
  observation: null,
});
describe("team public evidence boundary", () => {
  it("rejects malformed and omitted observations before they can become empty views", () => {
    const l = new EvidenceLedger();
    expect(
      l.accept(
        [
          { ...packet(), observation: undefined } as any,
          { ...packet(), sensorId: 17 } as any,
          { ...packet(), messageId: 3 } as any,
        ],
        1,
      ),
    ).toEqual([]);
    expect(l.stats.invalid).toBe(3);
    expect(() => l.accept([], NaN)).toThrow();
  });
  it("deduplicates exact retransmissions, rejects conflicting IDs independent of order and freezes ownership", () => {
    const p = packet(),
      other = { ...p, pose: { ...p.pose, x: 2 } };
    for (const batch of [
      [p, other],
      [other, p],
    ]) {
      const l = new EvidenceLedger();
      expect(l.accept(batch, 1)).toEqual([]);
      expect(l.stats.conflicts).toBe(2);
    }
    const l = new EvidenceLedger(),
      accepted = l.accept([p, p], 1);
    expect(accepted).toHaveLength(1);
    expect(Object.isFrozen(accepted[0])).toBe(true);
    expect(Object.isFrozen(accepted[0].pose)).toBe(true);
    expect(l.accept([{ ...p, receivedAt: 2 }], 2)).toEqual([]);
    expect(l.stats.duplicates).toBe(2);
  });
  it("rejects stale and future data without interpreting it as missing detection", () => {
    const l = new EvidenceLedger();
    l.accept([packet("A", 2)], 2);
    expect(l.accept([packet("B", 1), packet("B", 4)], 3)).toEqual([]);
    expect(l.stats.stale).toBe(1);
    expect(l.stats.future).toBe(1);
  });
  it("does not touch forbidden evaluation getters", () => {
    const p = packet();
    for (const k of [
      "subject",
      "visibility",
      "action",
      "posture",
      "cover",
      "route",
    ]) {
      Object.defineProperty(p, k, {
        enumerable: true,
        get() {
          throw Error("hidden " + k);
        },
      });
    }
    const b = new TeamBelief(new TeamMap(flat), INITIAL_REGION);
    expect(() => b.ingest([p], 1)).not.toThrow();
  });
  it("unions partial subcell evidence identically for joint and split simultaneous deliveries", () => {
    const results = [];
    for (const mode of [0, 1, 2]) {
      const map = new TeamMap(flat);
      map.footprint = (p) => {
        const m = new Uint16Array(1024);
        m[500] = p.x === 0 ? 3 : 60;
        return m;
      };
      const b = new TeamBelief(map, INITIAL_REGION),
        a = packet(),
        c = { ...packet("B"), pose: { ...packet("B").pose, x: 1 } };
      if (mode === 0) b.ingest([a, c], 1);
      if (mode === 1) {
        b.ingest([a], 1);
        b.ingest([c], 1);
      }
      if (mode === 2) {
        b.ingest([c], 1);
        b.ingest([a], 1);
      }
      results.push([...b.probability]);
    }
    for (let k = 0; k < 1024; k++) {
      expect(results[1][k]).toBeCloseTo(results[0][k], 12);
      expect(results[2][k]).toBeCloseTo(results[0][k], 12);
    }
  });
});
describe("coarse full-grid semantics", () => {
  it("keeps finite normalized boundary mass with no unintended zero-velocity advection", () => {
    const map = new TeamMap(flat),
      b = new TeamBelief(map, INITIAL_REGION);
    b.probability.fill(0);
    b.probability[0] = 1;
    b.advance(0.01);
    expect(b.probability[0]).toBeCloseTo(0.99, 4);
    expect(b.probability.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
    expect(b.probability.every(Number.isFinite)).toBe(true);
  });
  it("has mirror-symmetric subcell quadrature and mirrored visible fraction", () => {
    const map = new TeamMap(flat),
      a = map.footprint({ x: -18, y: 3, z: -20, yaw: 0.4, pitch: -0.2 }),
      b = map.footprint({ x: 18, y: 3, z: -20, yaw: -0.4, pitch: -0.2 });
    for (let row = 0; row < 32; row++)
      for (let col = 0; col < 32; col++)
        expect(fraction(a[row * 32 + col])).toBe(
          fraction(b[row * 32 + 31 - col]),
        );
  });
  it("does not make a narrow Gaussian disappear between 6m cell centers", () => {
    const b = new TeamBelief(new TeamMap(flat), {
        minX: -24,
        maxX: 24,
        minZ: -24,
        maxZ: 24,
      }),
      p = packet();
    b.ingest([{ ...p, observation: { t: 1, x: 0, z: 0, sigma: 0.4 } }], 1);
    expect(b.probability.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
    expect(b.summary().x).toBeCloseTo(0, 8);
    expect(b.summary().z).toBeCloseTo(0, 8);
    expect(
      [...b.probability]
        .sort((a, b) => b - a)
        .slice(0, 4)
        .reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(0.999);
  });
  it("fails instead of normalizing empty valid support into NaNs", () => {
    const map = new TeamMap({ ...flat, half: 2 });
    expect(() => map.prior(INITIAL_REGION)).toThrow("no valid grid support");
  });
});
describe("initial finding and metric correctness", () => {
  it("holds crossing swept paths even when endpoints remain separated", () => {
    const before = [
      {
        id: "A" as const,
        state: makeDrone(flat, { x: -5, z: 0 }, { x: 0, z: 0 }),
      },
      {
        id: "B" as const,
        state: makeDrone(flat, { x: 5, z: 0 }, { x: 0, z: 0 }),
      },
    ];
    const after = structuredClone(before);
    after[0].state.pos.x = 5;
    after[1].state.pos.x = -5;
    expect(
      sweptSeparation(
        before[0].state,
        after[0].state,
        before[1].state,
        after[1].state,
      ),
    ).toBe(0);
    expect(enforceSeparation(before, after.reverse())).toBe(true);
    for (const a of after) {
      expect(a.state.pos).toEqual(before.find((b) => b.id === a.id)!.state.pos);
      expect(a.state.vel).toEqual({ x: 0, y: 0, z: 0 });
    }
  });
  it("keeps public map independent of hidden spawn/routes and rejects reserve seeds", () => {
    const a = generateTeamScenario(220000, 225000, "rich"),
      b = generateTeamScenario(220000, 225001, "rich");
    expect(JSON.stringify(a.public)).toBe(JSON.stringify(b.public));
    for (let x = -80; x <= 80; x += 8)
      for (let z = -80; z <= 80; z += 8)
        expect(a.public.world.heightAt(x, z)).toBe(
          b.public.world.heightAt(x, z),
        );
    expect(a.hidden.goals).not.toEqual(b.hidden.goals);
    expect(() => buildPublicScenario(320000, "rich")).toThrow("reserve");
    expect(() => generateTeamScenario(220000, 325000, "rich")).toThrow(
      "reserve",
    );
  });
  it("starts with actual geometric non-detection throughout the common prefix", () => {
    const s = generateTeamScenario(220000, 225000, "rich"),
      d = initialDrones(s.public),
      a = makeSubject(s.public, s.hidden);
    for (let k = 0; k <= 20; k++) {
      const t = a.snapshot();
      expect(d.some((x) => canSense(s.public.world, x.state, t))).toBe(false);
      a.step(nearestDrone(d, t), 0.05);
    }
  });
  it("counts actual sensor intervals, including never-found and endpoint convention", () => {
    expect(observationMetrics(Array(1500).fill(true), 0.05).totalNoFixS).toBe(
      0,
    );
    const never = observationMetrics(Array(1500).fill(false), 0.05);
    expect(never.totalNoFixS).toBeCloseTo(75, 8);
    expect(never.initialAcquired).toBe(false);
    expect(never.initialAcquisitionS).toBe(75);
  });
  it("is deterministic across repeated short independent runs", () => {
    const s = generateTeamScenario(220001, 225001, "original"),
      a = simulateTeam(s, "independent", { duration: 2 }),
      b = simulateTeam(s, "independent", { duration: 2 });
    expect(a.frames).toEqual(b.frames);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.metrics.initialAcquisitionS).toBeGreaterThanOrEqual(1);
  }, 120000);
  it("allocates separated complementary viewpoints with symmetric broad prior", () => {
    const map = new TeamMap(flat),
      belief = new TeamBelief(map, {
        minX: -24,
        maxX: 24,
        minZ: -24,
        maxZ: 24,
      }),
      planner = new TeamPlanner(map);
    const a = {
        id: "A" as const,
        state: makeDrone(flat, { x: -30, z: 0 }, { x: 0, z: 0 }),
      },
      b = {
        id: "B" as const,
        state: makeDrone(flat, { x: 30, z: 0 }, { x: 0, z: 0 }),
      };
    a.state.pos.y = b.state.pos.y = 3;
    const first = planner.plan(
        [a, b],
        new Map([
          ["A", belief],
          ["B", belief],
        ]),
        "coordinated",
      ),
      second = planner.plan(
        [b, a],
        new Map([
          ["B", belief],
          ["A", belief],
        ]),
        "coordinated",
      );
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(
      Math.hypot(
        first[0].goal.x - first[1].goal.x,
        first[0].goal.z - first[1].goal.z,
      ),
    ).toBeGreaterThanOrEqual(8);
    expect(first[0].goal.x * first[1].goal.x).toBeLessThan(0);
  }, 120000);
});
