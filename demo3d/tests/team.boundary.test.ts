import { describe, it, expect } from "vitest";
import { TeamMap } from "../src/team/map";
import { TeamBelief } from "../src/team/belief";
import { TeamPlanner } from "../src/team/planner";
import { makeDrone } from "../src/sim/drone";
import { INITIAL_REGION, type Evidence } from "../src/team/types";
import type { World } from "../src/sim/world";
function trap<T extends object>(o: T) {
  for (const key of [
    "subject",
    "subjectSeed",
    "hidden",
    "visibility",
    "posture",
    "action",
    "cover",
    "goals",
    "route",
  ])
    Object.defineProperty(o, key, {
      enumerable: true,
      get() {
        throw Error("Forbidden hidden access: " + key);
      },
    });
  return o;
}
describe("held-public-transcript team inference", () => {
  it("preserves posterior and allocation with throwing hidden properties on every public input", () => {
    const run = (guard: boolean) => {
      const world: World = {
        seed: 71,
        half: 95,
        trees: [],
        rocks: [],
        heightAt: () => 0,
      };
      const map = new TeamMap(guard ? trap(world) : world),
        belief = new TeamBelief(map, INITIAL_REGION);
      const packets: Evidence[] = [
        {
          messageId: "0",
          sensorId: "A",
          sensedAt: 0,
          receivedAt: 0,
          pose: { x: -20, y: 3, z: 45, yaw: Math.PI, pitch: -0.1 },
          observation: null,
        },
        {
          messageId: "0",
          sensorId: "B",
          sensedAt: 0,
          receivedAt: 0,
          pose: { x: 20, y: 3, z: 45, yaw: Math.PI, pitch: -0.1 },
          observation: null,
        },
      ];
      if (guard)
        for (const p of packets) {
          trap(p);
          trap(p.pose);
        }
      belief.ingest(packets, 0);
      const aircraft = [
        {
          id: "A" as const,
          state: makeDrone(world, { x: -30, z: 30 }, { x: 0, z: 0 }),
        },
        {
          id: "B" as const,
          state: makeDrone(world, { x: 30, z: 30 }, { x: 0, z: 0 }),
        },
      ];
      for (const d of aircraft) {
        d.state.pos.y = 3;
        if (guard) {
          trap(d);
          trap(d.state);
        }
      }
      const allocations = new TeamPlanner(map).plan(
        aircraft,
        new Map([
          ["A", belief],
          ["B", belief],
        ]),
        "coordinated",
      );
      return { probability: [...belief.probability], allocations };
    };
    expect(run(true)).toEqual(run(false));
  });
  it("does not turn assigned but unvisited viewpoints into negative evidence", () => {
    const world: World = {
        seed: 1,
        half: 95,
        trees: [],
        rocks: [],
        heightAt: () => 0,
      },
      map = new TeamMap(world),
      belief = new TeamBelief(map, INITIAL_REGION),
      before = [...belief.probability];
    new TeamPlanner(map).plan(
      [
        { id: "A", state: makeDrone(world, { x: -30, z: 30 }, { x: 0, z: 0 }) },
        { id: "B", state: makeDrone(world, { x: 30, z: 30 }, { x: 0, z: 0 }) },
      ],
      new Map([
        ["A", belief],
        ["B", belief],
      ]),
      "coordinated",
    );
    expect([...belief.probability]).toEqual(before);
    expect(belief.stats.emptyCellUpdates).toBe(0);
  });
});

describe("joint allocator fallback reporting", () => {
  it("marks overlap uncomputed when the joint goal separation cannot be met", () => {
    const world: World = {
        seed: 1,
        half: 95,
        trees: [],
        rocks: [],
        heightAt: () => 0,
      },
      map = new TeamMap(world),
      belief = new TeamBelief(map, INITIAL_REGION);
    const aircraft = [
      {
        id: "A" as const,
        state: makeDrone(world, { x: -3, z: 0 }, { x: 0, z: 0 }),
        searching: false,
      },
      {
        id: "B" as const,
        state: makeDrone(world, { x: 3, z: 0 }, { x: 0, z: 0 }),
        searching: false,
      },
    ];
    const result = new TeamPlanner(map).plan(
      aircraft,
      new Map([
        ["A", belief],
        ["B", belief],
      ]),
      "coordinated",
    );
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.overlap).toBeNull();
      expect(r.reason).toContain("fallback");
    }
  });
});
