import { describe, it, expect } from "vitest";
import {
  ThreeMotion,
  allPairSweeps,
  DetourProgress,
  ownerTier,
} from "../src/team/threeMotion";
import { certifyTerrain } from "../src/team/clearance";
import { makeDrone } from "../src/sim/drone";
import { DetourProgress as RecoveryClock } from "../src/team/recovery";
import { THREE_IDS, type SensorId } from "../src/team/types";
import type { World } from "../src/sim/world";
const world: World = {
  seed: 1,
  half: 95,
  trees: [],
  rocks: [],
  heightAt: () => 0,
};
certifyTerrain(world.heightAt, 0);
function crossing(reverse = false, detours = false) {
  let drones = THREE_IDS.map((id, i) => {
    const angle = (i * Math.PI * 2) / 3,
      state = makeDrone(
        world,
        { x: 12 * Math.cos(angle), z: 12 * Math.sin(angle) },
        { x: 0, z: 0 },
      );
    state.pos.y = 3;
    return { id, state };
  });
  const goals = drones.map((d) => ({
    id: d.id,
    x: -d.state.pos.x,
    z: -d.state.pos.z,
  }));
  const controller = new ThreeMotion(),
    trace: number[][] = [];
  let minimum = Infinity;
  for (let tick = 0; tick < 400; tick++) {
    const before = structuredClone(drones),
      next = structuredClone(drones);
    for (const d of next) {
      const g = goals.find((g) => g.id === d.id)!,
        dx = g.x - d.state.pos.x,
        dz = g.z - d.state.pos.z,
        n = Math.hypot(dx, dz),
        speed = Math.min(3, n * 2);
      d.state.vel = {
        x: (dx / (n || 1)) * speed,
        y: 0,
        z: (dz / (n || 1)) * speed,
      };
      d.state.pos.x += d.state.vel.x * 0.05;
      d.state.pos.z += d.state.vel.z * 0.05;
    }
    controller.apply(
      world,
      reverse ? [...before].reverse() : before,
      reverse ? [...next].reverse() : next,
      tick * 0.05,
      0.05,
      detours
        ? new Map(goals.map((g) => [g.id, { x: g.x, y: 3, z: g.z }]))
        : new Map(),
    );
    for (const p of allPairSweeps(before, next))
      minimum = Math.min(minimum, p.distance);
    drones = next;
    trace.push(
      drones.flatMap((d) => [d.state.pos.x, d.state.pos.y, d.state.pos.z]),
    );
  }
  return {
    minimum,
    trace,
    errors: drones.map((d) => {
      const g = goals.find((g) => g.id === d.id)!;
      return Math.hypot(d.state.pos.x - g.x, d.state.pos.z - g.z);
    }),
  };
}
describe("one joint three-drone physical decision", () => {
  it("ends the record lifetime on target absence, but never resets an uninterrupted target", () => {
    const p = new DetourProgress(),
      q = { x: 5, y: 3, z: 0 };
    p.update("C", q, 4, 0, true);
    p.queued("C", 0);
    p.serve("C", 4, 1);
    p.retain(new Set(["C"]));
    p.update("C", q, 4, 2, true);
    expect(p.snapshot("C", 2)).toMatchObject({
      firstSeen: 0,
      firstServiceAt: 1,
    });
    p.retain(new Set());
    p.update("C", q, 4, 10, true);
    expect(p.snapshot("C", 10)).toMatchObject({
      firstSeen: 10,
      queuedAt: null,
      firstServiceAt: null,
      expired: false,
    });
  });
  it("starts a queued target's nonrenewable progress clock only on first applied service", () => {
    const p = new DetourProgress(),
      target = { x: 5, y: 3, z: 0 };
    p.update("C", target, 4, 0, true);
    p.queued("C", 0);
    expect(p.update("C", target, 6, 4, true)).toBe(true);
    expect(p.snapshot("C", 4)?.firstServiceAt).toBeNull();
    p.serve("C", 6, 4);
    expect(p.firstSeen("C")).toBe(0);
    expect(p.snapshot("C", 4)).toMatchObject({
      firstServiceAt: 4,
      queueWaitS: 4,
      progressClockS: 0,
    });
    expect(p.update("C", target, 5.5, 6.9, true)).toBe(true);
    p.serve("C", 5.5, 8); // later ownership bookkeeping cannot renew service
    expect(p.snapshot("C", 8)?.firstServiceAt).toBe(4);
    expect(p.update("C", target, 5.5, 9.9, true)).toBe(false);
    expect(p.update("C", target, 1, 10, true)).toBe(false);
  });
  it("retains never-queued expiry and clears queued state on a new target", () => {
    const p = new DetourProgress(),
      target = { x: 5, y: 3, z: 0 };
    p.update("A", target, 4, 0, true);
    expect(p.update("A", target, 4, 3, true)).toBe(false);
    p.update("B", target, 4, 0, true);
    p.queued("B", 1);
    const changed = { ...target, z: 1 };
    p.update("B", changed, 4, 4, true);
    expect(p.snapshot("B", 4)).toMatchObject({
      firstSeen: 4,
      queuedAt: null,
      firstServiceAt: null,
    });
    expect(p.update("B", changed, 4, 7, true)).toBe(false);
  });
  it("ends queued eligibility on arrival or invalid remaining chord", () => {
    for (const reached of [false, true]) {
      const p = new DetourProgress(),
        target = { x: 5, y: 3, z: 0 };
      p.update("C", target, 4, 0, true);
      p.queued("C", 0);
      expect(p.update("C", target, reached ? 0.1 : 4, 1, reached)).toBe(false);
    }
  });
  it("does not stamp service when an owner is merely selected before the inactive fast path", () => {
    const drones = THREE_IDS.map((id, i) => {
      const state = makeDrone(
        world,
        { x: (i - 1) * 20, z: 0 },
        { x: 0, z: 10 },
      );
      state.pos.y = 3;
      return { id, state };
    });
    const motion = new ThreeMotion();
    motion.apply(
      world,
      drones,
      structuredClone(drones),
      0,
      0.05,
      new Map([["B", { x: 0, y: 3, z: 4 }]]),
    );
    expect(motion.diagnostic.ownerId).toBe("B");
    expect(motion.diagnostic.detourQueue[0].firstServiceAt).toBeNull();
    expect(motion.stats.ownerSteps.B).toBe(0);
  });
  it.each(["expiry", "target change"])(
    "hands a queued peer service in the same step as owner %s",
    (reason) => {
      const drones = THREE_IDS.map((id, i) => {
        const state = makeDrone(
          world,
          { x: i === 2 ? 25 : i * 6, z: 0 },
          { x: 0, z: 10 },
        );
        state.pos.y = 3;
        state.vel = { x: 0, y: 0, z: 0 };
        return { id, state };
      });
      const motion = new ThreeMotion();
      const targets = new Map<SensorId, { x: number; y: number; z: number }>([
        ["A", { x: 0, y: 3, z: 4 }],
        ["B", { x: 6, y: 3, z: 4 }],
      ]);
      motion.apply(world, drones, structuredClone(drones), 0, 0.05, targets);
      expect(motion.stats.ownerSteps.A).toBe(1);
      expect(
        motion.diagnostic.detourQueue.find((q) => q.id === "B"),
      ).toMatchObject({ queuedAt: 0, firstServiceAt: null });
      const at = reason === "expiry" ? 3 : 1;
      if (reason === "target change") targets.set("A", { x: 0, y: 3, z: 5 });
      motion.apply(
        world,
        [...drones].reverse(),
        structuredClone(drones).reverse(),
        at,
        0.05,
        targets,
      );
      expect(motion.diagnostic.ownerId).toBe("B");
      expect(motion.stats.ownerSteps.B).toBe(1);
      expect(
        motion.diagnostic.detourQueue.find((q) => q.id === "B"),
      ).toMatchObject({ firstSeen: 0, firstServiceAt: at, progressClockS: 0 });
    },
  );
  it("does not renew the recovery absolute cap when a queued target receives late service", () => {
    const clock = new RecoveryClock(4, 0),
      queue = new DetourProgress();
    const target = { x: 4, y: 3, z: 0 };
    queue.update("C", target, 4, 0, true);
    queue.queued("C", 0);
    expect(queue.update("C", target, 4, 11.95, true)).toBe(true);
    expect(queue.snapshot("C", 11.95)?.pendingFirstService).toBe(true);
    queue.serve("C", 4, 11.95);
    expect(queue.snapshot("C", 11.95)?.progressClockS).toBe(0);
    expect(clock.expiry(12)).toBe("cap");
    // Runtime recovery clears the target before motion; the absent-target cleanup ends priority.
    queue.retain(new Set());
    expect(queue.snapshot("C", 12)).toBeNull();
  });
  it("uses the global owner minimum before tolerance filtering, with stable tie order", () => {
    const rows = [
      { ownerDeviation: 0.1, cost: 0, order: 0 },
      { ownerDeviation: 0.04, cost: 100, order: 1 },
      { ownerDeviation: 0, cost: 200, order: 2 },
    ];
    expect(ownerTier(rows)).toBe(rows[1]);
    expect(ownerTier([...rows].reverse())).toBe(rows[1]);
  });
  it("keeps first-seen seniority independent of progress-clock resets", () => {
    const p = new DetourProgress();
    const q = { x: 5, y: 3, z: 0 };
    p.update("B", q, 5, 1, true);
    p.update("A", q, 5, 2, true);
    p.update("B", q, 4, 2.5, true);
    expect(p.firstSeen("B")).toBe(1);
    expect(p.firstSeen("A")).toBe(2);
    p.update("B", { ...q, x: 6 }, 5, 3, true);
    expect(p.firstSeen("B")).toBe(3);
  });
  it.each([
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
    ["B", "C", "A"],
    ["C", "A", "B"],
    ["C", "B", "A"],
  ])(
    "finishes a near-arrival detour with peer/owner/third IDs %s/%s/%s",
    (peer, owner, third) => {
      const positions = [
        { x: 61.407, y: 2.558, z: -20.264 },
        { x: 67.283, y: 2.599, z: -22.89 },
        { x: 66.577, y: 3.262, z: -34.026 },
      ];
      let drones = ([peer, owner, third] as SensorId[]).map((id, i) => {
        const state = makeDrone(world, positions[i], { x: 90, z: -23 });
        state.pos = { ...positions[i] };
        return { id, state };
      });
      const target = { x: 67.0686, y: 2.6334, z: -22.7786 };
      const motion = new ThreeMotion();
      let arrived: number | null = null,
        minimum = Infinity,
        maxHold = 0,
        run = 0;
      for (let k = 0; k < 240; k++) {
        const before = structuredClone(drones),
          next = structuredClone(drones);
        for (const d of next) {
          const q =
            d.id === owner
              ? target
              : { x: 90, y: d.state.pos.y, z: d.id === peer ? -22 : -34 };
          const delta = {
            x: q.x - d.state.pos.x,
            y: q.y - d.state.pos.y,
            z: q.z - d.state.pos.z,
          };
          const n = Math.hypot(delta.x, delta.y, delta.z);
          const speed =
            d.id === owner && arrived !== null
              ? 0
              : Math.min(d.id === owner ? 2 : 3, n * 2);
          d.state.vel = {
            x: (delta.x / (n || 1)) * speed,
            y: (delta.y / (n || 1)) * speed,
            z: (delta.z / (n || 1)) * speed,
          };
          for (const axis of ["x", "y", "z"] as const)
            d.state.pos[axis] += d.state.vel[axis] * 0.05;
        }
        motion.apply(
          world,
          before,
          next,
          k * 0.05,
          0.05,
          arrived === null ? new Map([[owner as SensorId, target]]) : new Map(),
        );
        for (const pair of allPairSweeps(before, next))
          minimum = Math.min(minimum, pair.distance);
        run = motion.emergencyIds.length ? run + 0.05 : 0;
        maxHold = Math.max(maxHold, run);
        drones = next;
        const b = drones[1].state.pos;
        if (
          arrived === null &&
          Math.hypot(b.x - target.x, b.y - target.y, b.z - target.z) <= 0.15
        )
          arrived = (k + 1) * 0.05;
      }
      expect(arrived).not.toBeNull();
      expect(arrived!).toBeLessThan(12);
      expect(minimum).toBeGreaterThanOrEqual(4);
      expect(maxHold).toBeLessThanOrEqual(3);
    },
  );
  it("bounds detour protection by net new progress and never renews an expired target", () => {
    const p = new DetourProgress(),
      target = { x: 5, y: 3, z: 0 };
    expect(p.update("C", target, 5, 0, true)).toBe(true);
    expect(p.update("C", target, 4.5, 2.9, true)).toBe(true);
    expect(p.update("C", target, 5, 5.8, true)).toBe(true);
    expect(p.update("C", target, 4.5, 5.9, true)).toBe(false);
    expect(p.update("C", target, 3, 6, true)).toBe(false);
    expect(p.update("C", { ...target, x: 6 }, 5, 6.1, true)).toBe(true);
    expect(p.update("C", { ...target, x: 6 }, 0.1, 6.2, true)).toBe(false);
  });
  it("permits globally safe progress with three competing detours independent of insertion order", () => {
    const a = crossing(false, true),
      b = crossing(true, true);
    expect(a.minimum).toBeGreaterThanOrEqual(4);
    expect(Math.max(...a.errors)).toBeLessThan(1);
    expect(a.trace).toEqual(b.trace);
  });
  it("requests escalation throughout the unresolved 8-to-10m latch band", () => {
    const drones = THREE_IDS.map((id, i) => {
      const state = makeDrone(
        world,
        { x: [0, 9, 30][i], z: 0 },
        { x: 0, z: 10 },
      );
      state.pos.y = 3;
      return { id, state };
    });
    for (const enabled of [false, true]) {
      const motion = new ThreeMotion({ fullEscalationBand: enabled }) as any;
      motion.active = true;
      motion.began = 0;
      motion.lastBackoff = 6;
      motion.anchorUntil = 8;
      motion.progressAt = 8;
      motion.sides = new Map([
        ["AB", { x: 0, y: 0, z: 1 }],
        ["AC", { x: 0, y: 0, z: 1 }],
        ["BC", { x: 0, y: 0, z: 1 }],
      ]);
      motion.apply(world, drones, structuredClone(drones), 9, 0.05);
      expect(motion.replanRequested).toBe(enabled);
    }
  });
  it("handles a three-way crossing with every continuous pair checked and stable input order", () => {
    const a = crossing(),
      b = crossing(true);
    expect(a.minimum).toBeGreaterThanOrEqual(4);
    expect(Math.max(...a.errors)).toBeLessThan(1);
    expect(b.trace).toEqual(a.trace);
  });
  it("rejects invalid overlapping starts instead of pretending an all-hold is safe", () => {
    const drones = THREE_IDS.map((id) => {
      const state = makeDrone(world, { x: 0, z: 0 }, { x: 1, z: 0 });
      state.pos.y = 3;
      return { id, state };
    });
    expect(() =>
      new ThreeMotion().apply(world, drones, structuredClone(drones), 0, 0.05),
    ).toThrow("Invalid");
  });
  it("does not read hidden getters on public poses/states/world", () => {
    const trap = (o: object) => {
      for (const key of [
        "subject",
        "hidden",
        "visibility",
        "posture",
        "action",
      ])
        Object.defineProperty(o, key, {
          enumerable: true,
          get() {
            throw Error("Forbidden");
          },
        });
    };
    const drones = THREE_IDS.map((id, i) => {
      const state = makeDrone(world, { x: i * 10 - 10, z: 0 }, { x: 0, z: 10 });
      state.pos.y = 3;
      return { id, state };
    });
    const next = structuredClone(drones);
    for (const d of [...drones, ...next]) {
      trap(d);
      trap(d.state);
      trap(d.state.pos);
      trap(d.state.vel);
    }
    const w = { ...world };
    trap(w);
    expect(() =>
      new ThreeMotion().apply(w, drones, next, 0, 0.05),
    ).not.toThrow();
  });
});
