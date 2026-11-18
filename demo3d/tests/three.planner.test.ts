import { describe, it, expect } from "vitest";
import { TeamMap } from "../src/team/map";
import { TeamBelief } from "../src/team/belief";
import { ThreePlanner } from "../src/team/threePlanner";
import { ThreeEstimate } from "../src/team/threeEstimate";
import { angularGaps } from "../src/team/threeUnion";
import { fovTest } from "../src/sim/sensor";
import { lineOfSight } from "../src/sim/geometry";
import { certifyTerrain } from "../src/team/clearance";
import { makeDrone, stepDrone } from "../src/sim/drone";
import { Tracker } from "../src/sim/tracker";
import { THREE_IDS, type Evidence, type SensorId } from "../src/team/types";
import type { World } from "../src/sim/world";
const world: World = {
  seed: 17,
  half: 95,
  trees: [],
  rocks: [],
  heightAt: () => 0,
};
certifyTerrain(world.heightAt, 0);
function setup() {
  const map = new TeamMap(world),
    belief = new TeamBelief(
      map,
      { minX: -24, maxX: 24, minZ: -24, maxZ: 24 },
      THREE_IDS,
    );
  const drones = THREE_IDS.map((id, i) => {
    const angle = (i * Math.PI * 2) / 3,
      state = makeDrone(
        world,
        { x: 30 * Math.cos(angle), z: 30 * Math.sin(angle) },
        { x: 0, z: 0 },
      );
    state.pos.y = 3;
    return { id, state, searching: false };
  });
  const packets: Evidence[] = drones.map((d) => ({
    messageId: "0",
    sensorId: d.id,
    sensedAt: 0,
    receivedAt: 0,
    pose: { ...d.state.pos, yaw: d.state.camYaw, pitch: d.state.camPitch },
    observation: { t: 0, x: 0, z: 0, sigma: 1 },
  }));
  const accepted = belief.ingest(packets, 0),
    estimate = new ThreeEstimate().update(accepted, 0, { vx: 0, vz: 0 })!;
  const own = new Map(
    drones.map((d) => {
      const tracker = new Tracker();
      tracker.update({ t: 0, x: 0, z: 0, sigma: 1 });
      return [d.id, tracker.snapshot()] as const;
    }),
  );
  return {
    map,
    drones,
    estimate,
    own,
    beliefs: new Map(THREE_IDS.map((id) => [id, belief])),
  };
}
describe("three-drone joint view planning", () => {
  it("retries an unconfirmed reached slot and resets its dwell on a changed assignment", () => {
    const s = setup(),
      p = new ThreePlanner(s.map);
    for (const id of THREE_IDS) s.own.set(id, new Tracker().snapshot());
    p.update(0, s.drones, s.beliefs, s.own, "coordinated", s.estimate);
    const first = p.snapshot().map((t) => ({ id: t.id, goal: { ...t.goal } }));
    for (const d of s.drones) {
      const q = first.find((x) => x.id === d.id)!.goal;
      d.state.pos = { x: q.x, y: 3, z: q.z };
    }
    p.update(1.5, s.drones, s.beliefs, s.own, "coordinated", {
      ...s.estimate,
      t: 1.5,
    });
    p.update(3.5, s.drones, s.beliefs, s.own, "coordinated", {
      ...s.estimate,
      t: 3.5,
    });
    expect(p.stats.slotRetries).toBe(3);
    for (const task of p.snapshot())
      expect(task.goal).not.toEqual(first.find((x) => x.id === task.id)!.goal);
    const retries = p.stats.slotRetries;
    p.update(5, s.drones, s.beliefs, s.own, "coordinated", {
      ...s.estimate,
      t: 5,
    });
    expect(p.stats.slotRetries).toBe(retries);
  });
  it("ranks ordinary utility after selecting angular diversity", () => {
    const s = setup(),
      p = new ThreePlanner(s.map) as any;
    const make = (x: number, z: number, mass: number) => ({
      view: {
        x,
        y: 3,
        z,
        yaw: 0,
        pitch: 0,
        gaze: { x: 0, z: 0 },
        indices: new Uint16Array(),
        fractions: new Float32Array(),
        bits: new Uint16Array(),
      },
      mass,
      score: mass,
      distance: 1,
      waypoint: { x, z },
    });
    const strong = make(10, -10, 0.9),
      weak = make(10, 1, 0.1);
    p.base.candidates = () => [strong, weak];
    p.nav.paths = (_: unknown, points: any[]) =>
      points.map((q) => ({ distance: 1, waypoint: q }));
    const ranked = p.ordinary(
      { ...s.drones[0], searching: true },
      s.beliefs.get("A"),
      "independent",
      { x: 0, z: 0 },
    );
    expect(ranked.map((c: any) => c.mass)).toEqual([0.9, 0.1]);
  });
  it("ends shared investigation on the very next own-confirmation tick", () => {
    const s = setup(),
      p = new ThreePlanner(s.map);
    const unseen = new Tracker().snapshot();
    s.own.set("A", unseen);
    p.update(0, s.drones, s.beliefs, s.own, "shared", s.estimate);
    expect(p.getTask("A")).toBeDefined();
    const fix = new Tracker();
    fix.update({ t: 0.05, x: 0, z: 0, sigma: 1 });
    s.own.set("A", fix.snapshot());
    expect(
      p.update(0.05, s.drones, s.beliefs, s.own, "shared", s.estimate),
    ).toBe(true);
    expect(p.getTask("A")).toBeUndefined();
  });
  it("moves confirmed drones to reached, useful separated viewpoints in a closed loop", () => {
    const s = setup(),
      p = new ThreePlanner(s.map);
    const starts = s.drones.map((d) => ({ ...d.state.pos }));
    for (let k = 0; k < 400; k++) {
      const t = k * 0.05;
      p.update(t, s.drones, s.beliefs, s.own, "coordinated", {
        ...s.estimate,
        t,
      });
      for (const d of s.drones) {
        const task = p.getTask(d.id)!,
          a = p.getAllocations().find((a) => a.id === d.id)!;
        const reached =
          Math.hypot(d.state.pos.x - task.goal.x, d.state.pos.z - task.goal.z) <
          2;
        const goal = reached
          ? { x: d.state.pos.x, z: d.state.pos.z }
          : a.waypoint;
        d.state.replanT = 0;
        stepDrone(
          world,
          d.state,
          { ...s.own.get(d.id)!, status: "SEARCHING" },
          s.beliefs.get(d.id)!.summary(),
          t,
          0.05,
          { chooseViewpoint: () => goal, gazeTarget: () => ({ x: 0, z: 0 }) },
        );
      }
    }
    for (const [i, d] of s.drones.entries()) {
      const task = p.getTask(d.id)!;
      const target = { x: 0, y: 1.3, z: 0 };
      const sensed = fovTest(
        d.state.pos,
        d.state.camYaw,
        d.state.camPitch,
        target,
      );
      expect(
        sensed.inFov &&
          sensed.inRange &&
          lineOfSight(world, d.state.pos, target) === "NONE",
      ).toBe(true);
      expect(
        Math.hypot(d.state.pos.x - starts[i].x, d.state.pos.z - starts[i].z),
      ).toBeGreaterThan(3);
      expect(
        Math.hypot(d.state.pos.x - task.goal.x, d.state.pos.z - task.goal.z),
      ).toBeLessThan(2.1);
    }
    for (const gap of angularGaps(
      s.drones.map((d) => d.state.pos),
      { x: 0, z: 0 },
    )) {
      expect(gap).toBeGreaterThanOrEqual(90);
      expect(gap).toBeLessThanOrEqual(150);
    }
  });

  it("chooses symmetric distinct support views and retains physical slots across source handoff", () => {
    const s = setup(),
      p = new ThreePlanner(s.map);
    expect(
      p.update(0, s.drones, s.beliefs, s.own, "coordinated", s.estimate),
    ).toBe(true);
    const goals = p.getAllocations().map((a) => a.goal);
    expect(goals).toHaveLength(3);
    for (const gap of angularGaps(goals, s.estimate)) {
      expect(gap).toBeGreaterThanOrEqual(90);
      expect(gap).toBeLessThanOrEqual(150);
    }
    expect(p.snapshot()).toHaveLength(3);
    for (const [i, id] of THREE_IDS.entries()) {
      p.update(
        (i + 1) * 1.5,
        [...s.drones].reverse(),
        s.beliefs,
        s.own,
        "coordinated",
        {
          ...s.estimate,
          t: (i + 1) * 1.5,
          sources: s.estimate.sources.filter((source) => source.id === id),
        },
      );
      expect(p.getAllocations().map((a) => a.goal)).toEqual(goals);
      expect(
        p
          .snapshot()
          .every(
            (task) =>
              task.estimate.sources.length === 1 &&
              task.estimate.sources[0].id === id,
          ),
      ).toBe(true);
    }
  });
  it("returns genuine ordinary allocations when support goals cannot form a spaced tuple", () => {
    const s = setup(),
      p = new ThreePlanner(s.map) as any;
    const candidate = (x: number, task: boolean) => ({
      view: {
        x,
        y: 3,
        z: 0,
        yaw: 0,
        pitch: 0,
        gaze: { x: 0, z: 0 },
        indices: new Uint16Array(),
        fractions: new Float32Array(),
        bits: new Uint16Array(),
      },
      mask: new Uint16Array(1024),
      mass: 0,
      distance: 0,
      score: 0,
      waypoint: { x, z: 0 },
      support: 1,
      task,
    });
    p.support = () => [candidate(0, true)];
    p.ordinary = (d: { id: SensorId }) => [
      candidate(THREE_IDS.indexOf(d.id) * 20, false),
    ];
    p.update(0, s.drones, s.beliefs, s.own, "coordinated", s.estimate);
    expect(p.getAllocations().map((a: any) => a.goal.x)).toEqual([0, 20, 40]);
    expect(p.snapshot()).toEqual([]);
  });
  it("treats a cooldown ordinary allocation as a fixed joint constraint", () => {
    const s = setup(),
      p = new ThreePlanner(s.map) as any;
    const candidate = (x: number) => ({
      view: {
        x,
        y: 3,
        z: 0,
        yaw: 0,
        pitch: 0,
        gaze: { x: 0, z: 0 },
        indices: new Uint16Array(),
        fractions: new Float32Array(),
        bits: new Uint16Array(),
      },
      mask: new Uint16Array(1024),
      mass: 0,
      distance: 0,
      score: 0,
      waypoint: { x, z: 0 },
      support: 0,
      task: false,
    });
    p.cooldown.set("A", 3);
    p.ordinary = (d: { id: SensorId }) =>
      d.id === "A"
        ? [candidate(0), candidate(-20)]
        : [candidate(d.id === "B" ? 20 : 40)];
    p.update(0, s.drones, s.beliefs, s.own, "shared", null);
    expect(p.getAllocations().find((a: any) => a.id === "A").goal.x).toBe(0);
  });
});
