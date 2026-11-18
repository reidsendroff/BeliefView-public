import { describe, it, expect, vi } from "vitest";
import { TeamAssist, ASSIST, hasRecentOwnFix } from "../src/team/assist";
import { TeamMap } from "../src/team/map";
import { TeamPlanner, type Aircraft } from "../src/team/planner";
import { TeamBelief } from "../src/team/belief";
import { makeDrone, stepDrone, DRONE } from "../src/sim/drone";
import { Tracker } from "../src/sim/tracker";
import { canSense } from "../src/team/scenario";
import { certifyTerrain } from "../src/team/clearance";
import type { World } from "../src/sim/world";
import type { Evidence, SensorId } from "../src/team/types";
const flat = () => 0;
certifyTerrain(flat, 0);
const world: World = {
  seed: 1,
  half: 95,
  trees: [],
  rocks: [],
  heightAt: flat,
};
const prior = { minX: -24, maxX: 24, minZ: -12, maxZ: 36 };
function setup() {
  const map = new TeamMap(world),
    planner = new TeamPlanner(map),
    assist = new TeamAssist(map, planner);
  const drones: Aircraft[] = [
    { id: "A", state: makeDrone(world, { x: -16, z: 0 }, { x: 0, z: 0 }) },
    { id: "B", state: makeDrone(world, { x: 48, z: 16 }, { x: 0, z: 0 }) },
  ];
  for (const d of drones) d.state.pos.y = 3;
  const trackers = new Map<SensorId, Tracker>([
    ["A", new Tracker()],
    ["B", new Tracker()],
  ]);
  trackers.get("A")!.update({ t: 1, x: 0, z: 0, sigma: 0.5 });
  return {
    map,
    planner,
    assist,
    drones,
    trackers,
    own: () => new Map([...trackers].map(([id, t]) => [id, t.snapshot()])),
  };
}
function cue(t = 1): Evidence {
  return {
    messageId: String(t),
    sensorId: "A",
    sensedAt: t,
    receivedAt: t,
    pose: { x: -16, y: 3, z: 0, yaw: Math.PI / 2, pitch: 0 },
    observation: { t, x: 0, z: 0, sigma: 0.5 },
  };
}
describe("explicit teammate investigation", () => {
  it("uses the exact existing recent-own threshold and suppresses a single missed sample", () => {
    expect(hasRecentOwnFix({ initialised: true, age: 1.5 })).toBe(true);
    expect(hasRecentOwnFix({ initialised: true, age: 1.500001 })).toBe(false);
    const s = setup();
    s.trackers.get("B")!.update({ t: 1, x: 0, z: 0, sigma: 0.5 });
    s.trackers.get("B")!.predict(0.05);
    s.assist.update(1.05, s.drones, s.own(), [cue()]);
    expect(s.assist.allocations()).toHaveLength(0);
  });
  it("dispatches a distinct reachable view, preserves own confirmation and expires stale reports", () => {
    const s = setup();
    expect(s.assist.update(1, s.drones, s.own(), [cue()])).toBe(true);
    const a = s.assist.allocations()[0];
    expect(a.id).toBe("B");
    expect(Math.hypot(a.goal.x, a.goal.z)).toBeGreaterThanOrEqual(
      ASSIST.minStandoffM,
    );
    expect(Math.hypot(a.goal.x + 16, a.goal.z)).toBeGreaterThanOrEqual(
      ASSIST.sourceSpacingM,
    );
    expect(s.own().get("B")!.initialised).toBe(false);
    s.assist.update(4.05, s.drones, s.own(), []);
    expect(s.assist.allocations()).toHaveLength(0);
    expect(s.assist.snapshot()[0].state).toBe("expired");
  });
  it("only consumes packets accepted by the shared ledger, not missing, malformed or future data", () => {
    const s = setup(),
      b = new TeamBelief(s.map, prior);
    const bad = [
      { ...cue(), observation: undefined },
      {
        ...cue(),
        sensedAt: 2,
        receivedAt: 2,
        observation: { t: 2, x: 0, z: 0, sigma: 1 },
      },
      { ...cue(), messageId: "empty", observation: null },
    ] as Evidence[];
    const accepted = b.ingest(bad, 1);
    expect(accepted).toHaveLength(1);
    s.assist.update(1, s.drones, s.own(), accepted);
    expect(s.assist.allocations()).toHaveLength(0);
  });
  it("is deterministic for reordered and duplicated accepted source batches", () => {
    const a = cue(),
      b = {
        ...cue(),
        sensorId: "B" as const,
        pose: { x: 48, y: 3, z: 16, yaw: 0, pitch: 0 },
      };
    const outputs = [];
    for (const batch of [
      [a, b],
      [b, a],
      [b, a, b, a],
    ]) {
      const s = setup(),
        belief = new TeamBelief(s.map, prior);
      const accepted = belief.ingest(batch, 1);
      s.assist.update(1, s.drones, s.own(), accepted);
      outputs.push({
        status: s.assist.snapshot(),
        allocations: s.assist.allocations(),
      });
    }
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
    expect(outputs[0].status[0].source).toBe("A");
  });
  it("releases after bounded arrival dwell and does not immediately redispatch", () => {
    const s = setup();
    s.assist.update(1, s.drones, s.own(), [cue()]);
    const goal = s.assist.allocations()[0].goal;
    s.drones[1].state.pos = { ...goal, y: 3 };
    for (let t = 1.5; t <= 3.5; t += 0.5)
      s.assist.update(t, s.drones, s.own(), [cue(t)]);
    expect(s.assist.snapshot()[0].state).toBe("dwell-expired");
    s.assist.update(4, s.drones, s.own(), [cue(4)]);
    expect(s.assist.allocations()).toHaveLength(0);
  });
  it("reroutes a retained but unreachable goal and resets its arrival dwell", () => {
    const s = setup();
    s.assist.update(1, s.drones, s.own(), [cue()]);
    const old = s.assist.allocations()[0].goal;
    s.drones[1].state.pos = { ...old, y: 3 };
    s.assist.update(1.5, s.drones, s.own(), [cue(1.5)]);
    const route = s.planner.routes.bind(s.planner);
    vi.spyOn(s.planner, "routes").mockImplementation((origin, positions) =>
      route(origin, positions).map((p, i) =>
        positions[i].x === old.x && positions[i].z === old.z ? null : p,
      ),
    );
    s.assist.update(2.5, s.drones, s.own(), [cue(2.5)]);
    const next = s.assist.allocations()[0].goal;
    expect(next).not.toEqual(old);
    s.drones[1].state.pos = { ...next, y: 3 };
    s.assist.update(2.55, s.drones, s.own(), []);
    s.assist.update(3.5, s.drones, s.own(), [cue(3.5)]);
    expect(s.assist.snapshot()[0].state).toBe("investigating");
  });
  it("does not start arrival dwell while still above the low observation altitude", () => {
    const s = setup();
    s.assist.update(1, s.drones, s.own(), [cue()]);
    s.drones[1].state.pos = { ...s.assist.allocations()[0].goal, y: 24 };
    for (let t = 1.5; t <= 4; t += 0.5)
      s.assist.update(t, s.drones, s.own(), [cue(t)]);
    expect(s.assist.snapshot()[0].state).toBe("investigating");
  });
  it("reports unavailable geometry without claiming a global route proof", () => {
    const s = setup();
    s.map.positions.length = 0;
    s.assist.update(1, s.drones, s.own(), [cue()]);
    expect(s.assist.snapshot()[0].state).toBe("unavailable");
    expect(s.assist.allocations()).toHaveLength(0);
  });
  it("does not read forbidden truth or nested state getters", () => {
    const s = setup(),
      packet = cue();
    for (const obj of [
      world,
      ...s.drones,
      ...s.drones.map((d) => d.state),
      ...s.drones.map((d) => d.state.pos),
      packet,
      packet.pose,
      packet.observation!,
    ])
      Object.defineProperty(obj, "subject", {
        get() {
          throw Error("forbidden truth");
        },
        configurable: true,
      });
    expect(() => s.assist.update(1, s.drones, s.own(), [packet])).not.toThrow();
    delete (world as unknown as Record<string, unknown>).subject;
  });
  it("moves promptly toward support and confirms only through its own geometric sensor", () => {
    const s = setup(),
      b = s.drones[1],
      own = s.trackers.get("B")!;
    const target = { x: 0, y: 0, z: 0, crouch: 0 } as Parameters<
      typeof canSense
    >[2];
    expect(canSense(world, b.state, target)).toBe(false);
    let firstCommand: number | null = null,
      confirmed: number | null = null,
      startDistance = Infinity;
    for (let i = 20; i < 420; i++) {
      const t = i * 0.05;
      own.predict(0.05);
      if (canSense(world, b.state, target)) {
        own.update({ t, x: 0, z: 0, sigma: 0.5 });
        confirmed ??= t;
      }
      const changed = s.assist.update(
        t,
        s.drones,
        s.own(),
        i % 10 === 0 ? [cue(t)] : [],
      );
      if (changed) b.state.replanT = 0;
      const allocation = s.assist.allocations()[0];
      if (!allocation && confirmed !== null) break;
      if (allocation) {
        firstCommand ??= t;
        startDistance = Math.min(
          startDistance,
          Math.hypot(b.state.pos.x, b.state.pos.z),
        );
        const control = { ...own.snapshot(), status: "SEARCHING" as const };
        stepDrone(world, b.state, control, { x: 0, z: 0 }, t, 0.05, {
          chooseViewpoint: () => allocation.waypoint,
          gazeTarget: () => allocation.gaze,
        });
        expect(Math.hypot(b.state.vel.x, b.state.vel.z)).toBeLessThanOrEqual(
          DRONE.maxHSpeed + 1e-8,
        );
      }
    }
    expect(firstCommand).toBe(1);
    expect(startDistance).toBeLessThan(45);
    expect(confirmed).not.toBeNull();
    expect(s.assist.snapshot()[0].state).toBe("confirmed");
  });
});
