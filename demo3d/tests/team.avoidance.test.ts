import { certifyTerrain } from "../src/team/clearance";
import { describe, it, expect } from "vitest";
import { TeamAvoidance, clearMotion } from "../src/team/avoidance";
import { enforceSeparation, sweptSeparation } from "../src/team/separation";
import { assertNotReserved } from "../src/team/seeds";
import { makeDrone, DRONE } from "../src/sim/drone";
import type { World } from "../src/sim/world";
import type { SensorId } from "../src/team/types";
const flat: World = {
  seed: 1,
  half: 95,
  trees: [],
  rocks: [],
  heightAt: () => 0,
};
certifyTerrain(flat.heightAt, 0);
const drone = (id: SensorId, x: number, z: number) => {
  const state = makeDrone(flat, { x, z }, { x: 0, z: 0 });
  state.pos.y = 3;
  return { id, state };
};
function fixture(starts: number[][], goals: number[][], seconds = 30) {
  const avoid = new TeamAvoidance();
  let d = [
    drone("A", ...(starts[0] as [number, number])),
    drone("B", ...(starts[1] as [number, number])),
  ];
  let min = Infinity,
    holds = 0,
    maxSpeed = 0,
    maxUnheldAccel = 0;
  const reached = [false, false];
  for (let i = 0; i < seconds / 0.05; i++) {
    const next = structuredClone(d);
    for (let k = 0; k < 2; k++) {
      const s = next[k].state,
        dx = goals[k][0] - s.pos.x,
        dz = goals[k][1] - s.pos.z,
        dist = Math.hypot(dx, dz),
        speed = Math.min(5, dist);
      if (dist < 1) reached[k] = true;
      const vx = dist ? (dx / dist) * speed : 0,
        vz = dist ? (dz / dist) * speed : 0,
        ax = vx - s.vel.x,
        az = vz - s.vel.z,
        f = Math.min(
          1,
          (DRONE.maxAccel * 0.05) / Math.max(Math.hypot(ax, az), 1e-9),
        );
      s.vel.x += ax * f;
      s.vel.z += az * f;
      s.pos.x += s.vel.x * 0.05;
      s.pos.z += s.vel.z * 0.05;
    }
    avoid.apply(flat, d, next, i * 0.05, 0.05);
    const held = enforceSeparation(d, next) || avoid.emergency;
    if (held) holds++;
    min = Math.min(
      min,
      sweptSeparation(d[0].state, next[0].state, d[1].state, next[1].state),
    );
    for (let k = 0; k < 2; k++) {
      const a = d[k].state,
        b = next[k].state;
      maxSpeed = Math.max(
        maxSpeed,
        Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z) / 0.05,
      );
      if (!held)
        maxUnheldAccel = Math.max(
          maxUnheldAccel,
          Math.hypot(b.vel.x - a.vel.x, b.vel.z - a.vel.z) / 0.05,
        );
    }
    d = next;
  }
  return {
    min,
    holds,
    reached,
    maxSpeed,
    maxUnheldAccel,
    stats: avoid.stats,
    states: d,
  };
}
describe("bounded public-pose avoidance", () => {
  it("rejects uint32 aliases without generating a reserved world", () => {
    for (const n of [320000, 320000 + 2 ** 32, -1, NaN, Infinity, 0.5])
      expect(() => assertNotReserved(n)).toThrow();
    expect(() => assertNotReserved(0xffffffff)).not.toThrow();
  });
  it("is exactly the identity when disabled or no conflict is forecast", () => {
    const before = [drone("A", -30, 0), drone("B", 30, 0)],
      after = structuredClone(before);
    after[0].state.pos.z += 0.1;
    const reference = structuredClone(after),
      a = new TeamAvoidance();
    expect(a.apply(flat, before, after, 0, 0.05, false)).toBe(false);
    expect(after).toEqual(reference);
    expect(a.apply(flat, before, after, 0, 0.05, true)).toBe(false);
    expect(after).toEqual(reference);
  });
  for (const [name, starts, goals] of [
    [
      "head-on",
      [
        [-20, 0],
        [20, 0],
      ],
      [
        [20, 0],
        [-20, 0],
      ],
    ],
    [
      "perpendicular",
      [
        [-20, 0],
        [0, -20],
      ],
      [
        [20, 0],
        [0, 20],
      ],
    ],
    [
      "same goal opposite",
      [
        [-20, 0],
        [20, 0],
      ],
      [
        [0, 0],
        [0, 0],
      ],
    ],
    [
      "same goal same side",
      [
        [-20, 0],
        [-28, 0],
      ],
      [
        [0, 0],
        [0, 0],
      ],
    ],
    [
      "stationary buffer",
      [
        [0, 0],
        [8, 0],
      ],
      [
        [0, 0],
        [-20, 0],
      ],
    ],
    [
      "inside buffer",
      [
        [0, 0],
        [6, 0],
      ],
      [
        [0, 0],
        [-20, 0],
      ],
    ],
  ] as const)
    it(
      name + " preserves hard separation and reports unresolved progress",
      () => {
        const r = fixture(
          starts.map((x) => [...x]),
          goals.map((x) => [...x]),
        );
        expect(r.min).toBeGreaterThanOrEqual(4 - 1e-8);
        expect(r.maxSpeed).toBeLessThanOrEqual(8 + 1e-8);
        expect(r.maxUnheldAccel).toBeLessThanOrEqual(4 + 1e-8);
        expect(
          r.reached.every(Boolean) || r.stats.deadlocks > 0,
          JSON.stringify(r),
        ).toBe(true);
      },
    );
  it("uses deterministic physical-ID order and locks its yield side", () => {
    const before = [drone("A", -3, 0), drone("B", 3, 0)],
      after = structuredClone(before),
      a = new TeamAvoidance(),
      b = new TeamAvoidance();
    const reverse = structuredClone(after).reverse();
    a.apply(flat, before, after, 0, 0.05);
    b.apply(flat, [...before].reverse(), reverse, 0, 0.05);
    expect(after).toEqual(reverse.reverse());
    const side = a.diagnostic.side;
    a.apply(flat, after, structuredClone(after), 0.05, 0.05);
    expect(a.diagnostic.side).toEqual(side);
  });
  it("holds when terrain makes every steering candidate infeasible", () => {
    const w = { ...flat, heightAt: () => 10 },
      before = [drone("A", -3, 0), drone("B", 3, 0)],
      after = structuredClone(before),
      a = new TeamAvoidance();
    expect(clearMotion(w, before[0].state.pos, before[0].state.pos)).toBe(
      false,
    );
    a.apply(w, before, after, 0, 0.05);
    expect(a.emergency).toBe(true);
    expect(a.stats.noFeasiblePair).toBe(1);
    expect(after.map((d) => d.state.pos)).toEqual(
      before.map((d) => d.state.pos),
    );
  });
});

describe("avoidance inference isolation and reporting", () => {
  it("does not inspect hidden properties on map or aircraft states", () => {
    const before = [drone("A", -3, 0), drone("B", 3, 0)],
      after = structuredClone(before),
      w = { ...flat };
    for (const o of [
      w,
      ...before.map((x) => x.state),
      ...after.map((x) => x.state),
    ])
      for (const key of [
        "subject",
        "visibility",
        "posture",
        "action",
        "hiddenGoal",
      ])
        Object.defineProperty(o, key, {
          enumerable: true,
          get() {
            throw Error("hidden " + key);
          },
        });
    expect(() =>
      new TeamAvoidance().apply(w, before, after, 0, 0.05),
    ).not.toThrow();
  });
  it("freezes a backoff anchor instead of chasing a moving offset", () => {
    const a = new TeamAvoidance(),
      before = [drone("A", -3, 0), drone("B", 3, 0)];
    for (let i = 0; i <= 60; i++)
      a.apply(flat, before, structuredClone(before), i * 0.05, 0.05);
    const anchor = a.diagnostic.backoffAnchor;
    expect(anchor).not.toBeNull();
    const shifted = structuredClone(before);
    shifted[1].state.pos.z = 1;
    a.apply(flat, shifted, structuredClone(shifted), 3.05, 0.05);
    expect(a.diagnostic.backoffAnchor).toEqual(anchor);
    expect(a.stats.backoffs).toBe(1);
  });
});
it("projects public xyz fields without inspecting extra properties inside position or velocity", () => {
  const before = [drone("A", -3, 0), drone("B", 3, 0)],
    after = structuredClone(before);
  for (const aircraft of [...before, ...after])
    for (const vector of [aircraft.state.pos, aircraft.state.vel])
      Object.defineProperty(vector, "hiddenSubject", {
        enumerable: true,
        get() {
          throw Error("nested hidden subject");
        },
      });
  expect(() =>
    new TeamAvoidance().apply(flat, before, after, 0, 0.05),
  ).not.toThrow();
});
