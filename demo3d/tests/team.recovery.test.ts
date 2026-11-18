import { describe, it, expect } from "vitest";
import {
  certifyTerrain,
  validMotion,
  physicalMotion,
  clearanceState,
  CLEARANCE,
} from "../src/team/clearance";
import { TeamRecovery, recoveryTarget } from "../src/team/recovery";
import { makeDrone } from "../src/sim/drone";
import type { World, Tree } from "../src/sim/world";
const flat = () => 0;
certifyTerrain(flat, 0);
const tree: Tree = {
  x: 0,
  z: 0,
  groundY: 0,
  trunkR: 1,
  trunkTop: 10,
  canopyR: 0,
  canopyY: 20,
  hue: 0,
  grove: false,
};
const world = (trees: Tree[]): World => ({
  seed: 1,
  half: 95,
  trees,
  rocks: [],
  heightAt: flat,
});
const p = (x: number, y = 3, z = 0) => ({ x, y, z });
describe("team contact and physical geometry", () => {
  it("accepts exact inflated contact but rejects a meaningful inward step", () => {
    const w = world([tree]);
    expect(validMotion(w, p(2), p(2))).toBe(true);
    expect(validMotion(w, p(2), p(2, 3, 0.2))).toBe(true);
    expect(validMotion(w, p(2 + 2 * CLEARANCE.epsilonM), p(2 - 1e-4))).toBe(
      false,
    );
    expect(validMotion(w, p(2 - 1e-4), p(2))).toBe(true);
    expect(physicalMotion(w, p(0.9), p(2))).toBe(false);
  });
  it("rejects sphere and cylinder chords that improve endpoints while deepening the interior", () => {
    for (const t of [
      tree,
      { ...tree, trunkR: 0, trunkTop: 0, canopyR: 1, canopyY: 3 },
    ]) {
      const w = world([t]);
      expect(validMotion(w, p(-1.5), p(2.1))).toBe(false);
      expect(validMotion(w, p(1.95), p(2.2))).toBe(true);
    }
  });
  it("allows finite-cylinder cap and lateral overlap escape without shrinking solids", () => {
    expect(validMotion(world([tree]), p(0, 11), p(0, 11.1))).toBe(true);
    const w = world([
      { ...tree, x: -1.2 },
      { ...tree, x: 1.2 },
    ]);
    expect(physicalMotion(w, p(0), p(0, 3, 2))).toBe(true);
    expect(validMotion(w, p(0), p(0, 3, 2))).toBe(true);
    expect(validMotion(w, p(0), p(0.1))).toBe(false);
    expect(recoveryTarget(w, p(0))).not.toBeNull();
  });
  it("ignores zero-radius helper trunks and zero-radius canopy spheres", () => {
    expect(
      validMotion(world([{ ...tree, trunkR: 0, trunkTop: 0 }]), p(0), p(0.1)),
    ).toBe(true);
  });
  it("rejects an intervening narrow ridge and fails closed for uncertified terrain", () => {
    const height = (x: number) => 3 * Math.exp(-((x / 0.01) ** 2));
    certifyTerrain(height, 60000);
    const w = { ...world([]), heightAt: height };
    expect(physicalMotion(w, p(-0.1, 2), p(0.1, 2))).toBe(false);
    expect(
      physicalMotion({ ...w, heightAt: () => 0 }, p(-0.1, 2), p(0.1, 2)),
    ).toBe(false);
  });
});
describe("bounded deficit recovery", () => {
  it("recovers a real5cm margin deficit within2s without deeper clearance or teleport", () => {
    const w = world([tree]),
      r = new TeamRecovery();
    let d = {
      id: "A" as const,
      state: makeDrone(w, { x: 1.95, z: 0 }, { x: 4, z: 0 }),
    };
    d.state.pos = p(1.95);
    d.state.vel = { x: 0, y: 0, z: 0 };
    let clearAt = Infinity;
    for (let i = 0; i < 40; i++) {
      const next = structuredClone(d);
      r.apply(w, [d], [next], i * 0.05, 0.05);
      expect(validMotion(w, d.state.pos, next.state.pos)).toBe(true);
      expect(
        Math.hypot(
          next.state.pos.x - d.state.pos.x,
          next.state.pos.y - d.state.pos.y,
          next.state.pos.z - d.state.pos.z,
        ),
      ).toBeLessThanOrEqual(0.101);
      d = next;
      if (clearanceState(w, d.state.pos).totalDeficit === 0)
        clearAt = Math.min(clearAt, (i + 1) * 0.05);
    }
    expect(clearAt).toBeLessThan(2);
    expect(r.stats.blockedEvents).toBe(0);
    expect(r.stats.exits).toBe(1);
  });
  it("finds the narrow common escape cone between asymmetric trunk margins", () => {
    const w = world([
      {
        ...tree,
        x: -0.934101993194464,
        z: -0.804256256963292,
        trunkR: 0.23363091718405485,
      },
      {
        ...tree,
        x: 1.222978614480553,
        z: 0.328217489071953,
        trunkR: 0.26625566597329453,
      },
    ]);
    const target = recoveryTarget(w, p(0));
    expect(target).not.toBeNull();
    expect(validMotion(w, p(0), target!)).toBe(true);
    expect(clearanceState(w, target!).totalDeficit).toBe(0);
  });
  it("recovers a below-desired-AGL but above-ground start without descending", () => {
    const w = world([]),
      r = new TeamRecovery();
    let d = {
      id: "A" as const,
      state: makeDrone(w, { x: 0, z: 0 }, { x: 4, z: 0 }),
    };
    d.state.pos = p(0, 1.95);
    d.state.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 40; i++) {
      const next = structuredClone(d);
      r.apply(w, [d], [next], i * 0.05, 0.05);
      expect(next.state.pos.y).toBeGreaterThanOrEqual(d.state.pos.y - 1e-6);
      d = next;
    }
    expect(r.snapshot()[0].state).toBe("clear");
    expect(d.state.pos.y).toBeGreaterThan(2);
  });
  it("reports an invalid physical start as blocked rather than calling stationary valid", () => {
    const w = world([tree]),
      r = new TeamRecovery(),
      d = {
        id: "A" as const,
        state: makeDrone(w, { x: 0.5, z: 0 }, { x: 4, z: 0 }),
      };
    d.state.pos = p(0.5);
    const next = structuredClone(d);
    r.apply(w, [d], [next], 0, 0.05);
    expect(r.snapshot()[0].state).toBe("blocked");
    expect(r.snapshot()[0].reason).toContain("Invalid physical");
    expect(physicalMotion(w, d.state.pos, next.state.pos)).toBe(false);
  });
  it("does not read hidden state while correcting a public pose", () => {
    const w = world([tree]),
      r = new TeamRecovery(),
      d = {
        id: "A" as const,
        state: makeDrone(w, { x: 1.95, z: 0 }, { x: 4, z: 0 }),
      };
    d.state.pos = p(1.95);
    const next = structuredClone(d);
    for (const o of [w, d.state, next.state])
      Object.defineProperty(o, "subject", {
        enumerable: true,
        get() {
          throw Error("hidden");
        },
      });
    expect(() => r.apply(w, [d], [next], 0, 0.05)).not.toThrow();
  });
});

import stalls from "./fixtures/team-contact-stalls.json";
import { buildPublicScenario } from "../src/team/scenario";
import { detourPath } from "../src/team/recovery";
import { TeamAvoidance } from "../src/team/avoidance";
import { sweptSeparation } from "../src/team/separation";
it("finds validated public-geometry escapes for three recorded contact stalls", () => {
  for (const fixture of stalls) {
    const w = buildPublicScenario(
      fixture.worldSeed,
      fixture.family as "rich" | "original",
    ).world;
    const d = fixture.states.find((a) => a.id === fixture.affectedId)!;
    const command = { x: 0, y: 0, z: -1 };
    const path = detourPath(
      w,
      d.state.pos,
      command,
      clearanceState(w, d.state.pos).totalDeficit === 0,
    );
    expect(path).not.toBeNull();
    let previous = d.state.pos;
    for (const q of path!) {
      expect(validMotion(w, previous, q)).toBe(true);
      previous = q;
    }
    expect(clearanceState(w, previous).totalDeficit).toBe(0);
  }
});
it("latches a zero-deficit contact detour until meaningful progress, without side oscillation", () => {
  const w = world([tree]),
    r = new TeamRecovery();
  let d = {
    id: "A" as const,
    state: makeDrone(w, { x: 2, z: 0 }, { x: 0, z: 0 }),
  };
  d.state.pos = p(2);
  d.state.vel = { x: 0, y: 0, z: 0 };
  let target: ReturnType<typeof p> | null = null,
    firstExit = Infinity;
  for (let i = 0; i < 120; i++) {
    const next = structuredClone(d);
    next.state.pos.x -= 0.05;
    next.state.vel = { x: -1, y: 0, z: 0 };
    r.apply(w, [d], [next], i * 0.05, 0.05);
    r.audit(w, [d], [next]);
    expect(validMotion(w, d.state.pos, next.state.pos)).toBe(true);
    const s = r.snapshot()[0];
    if (i === 0) target = s.target;
    if (r.stats.exits === 0) expect(s.target).toEqual(target);
    if (r.stats.exits > 0) firstExit = Math.min(firstExit, i * 0.05);
    d = next;
  }
  expect(firstExit).toBeLessThan(6);
  expect(firstExit).toBeGreaterThan(0.5);
  expect(r.stats.blockedEvents).toBe(0);
});
it("joint avoidance preserves hard separation during a public detour", () => {
  const w = world([tree]),
    r = new TeamRecovery(),
    avoid = new TeamAvoidance();
  let drones = [
    { id: "A" as const, state: makeDrone(w, { x: 2, z: 0 }, { x: 0, z: 0 }) },
    { id: "B" as const, state: makeDrone(w, { x: 2, z: 5 }, { x: 0, z: 0 }) },
  ];
  drones[0].state.pos = p(2);
  drones[1].state.pos = p(2, 3, 5);
  for (const d of drones) d.state.vel = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 80; i++) {
    const next = structuredClone(drones);
    next[0].state.pos.x -= 0.05;
    next[0].state.vel.x = -1;
    r.apply(w, drones, next, i * 0.05, 0.05);
    avoid.apply(w, drones, next, i * 0.05, 0.05, true, r.activeIds);
    r.audit(w, drones, next);
    expect(
      sweptSeparation(
        drones[0].state,
        next[0].state,
        drones[1].state,
        next[1].state,
      ),
    ).toBeGreaterThanOrEqual(4 - 1e-8);
    for (let k = 0; k < 2; k++)
      expect(validMotion(w, drones[k].state.pos, next[k].state.pos)).toBe(true);
    drones = next;
  }
});
it("does not classify a valid partner yield beside a wall as a geometry stall", () => {
  const w = world([tree]),
    r = new TeamRecovery();
  const d = {
    id: "A" as const,
    state: makeDrone(w, { x: 2, z: 0 }, { x: 2, z: 10 }),
  };
  d.state.pos = p(2);
  d.state.vel = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 20; i++) {
    const next = structuredClone(d);
    next.state.pos.z += 0.05;
    next.state.vel.z = 1;
    r.apply(w, [d], [next], i * 0.05, 0.05);
    next.state.pos = { ...d.state.pos };
    next.state.vel = { x: 0, y: 0, z: 0 };
    r.audit(w, [d], [next]);
  }
  expect(r.stats.contactDetours).toBe(0);
});
it("caps retries for a physically free but locally inescapable margin pocket", () => {
  const walls: Tree[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        const n = Math.hypot(x, y, z);
        if (!n) continue;
        walls.push({
          ...tree,
          x: (1.5 * x) / n,
          z: (1.5 * z) / n,
          trunkR: 0,
          trunkTop: 0,
          canopyR: 0.3,
          canopyY: 3 + (1.5 * y) / n,
        });
      }
  const w = world(walls),
    r = new TeamRecovery();
  let d = {
    id: "A" as const,
    state: makeDrone(w, { x: 0, z: 0 }, { x: 4, z: 0 }),
  };
  d.state.pos = p(0);
  d.state.vel = { x: 0, y: 0, z: 0 };
  // Center is clear; deliberately request a point in the surrounding inflated barrier.
  for (let i = 0; i < 400; i++) {
    const next = structuredClone(d);
    next.state.pos.x += 0.3;
    next.state.vel.x = 6;
    r.apply(w, [d], [next], i * 0.05, 0.05);
    r.audit(w, [d], [next]);
    d = next;
  }
  expect(r.stats.entries).toBeLessThanOrEqual(4);
  expect(r.snapshot()[0].state).toBe("blocked");
});

import { DetourProgress } from "../src/team/recovery";
it("counts cumulative best-so-far progress and refuses oscillation resets", () => {
  const c = new DetourProgress(4, 0);
  for (let i = 1; i <= 24; i++) c.observe(4 - i * 0.01, i * 0.05);
  expect(c.lastProgress).toBe(0);
  c.observe(3.75, 1.25);
  expect(c.lastProgress).toBe(1.25);
  for (let i = 0; i < 50; i++) c.observe(i % 2 ? 3.8 : 3.75, 1.3 + i * 0.1);
  expect(c.lastProgress).toBe(1.25);
  expect(c.expiry(4.3)).toBeNull();
  expect(c.expiry(12)).toBe("cap");
});
it("handles final approach and a finite joint yield without resetting the absolute cap", () => {
  const c = new DetourProgress(4, 0);
  c.observe(3, 1);
  c.observe(3, 2.9);
  expect(c.expiry(2.9)).toBeNull();
  c.observe(2.5, 3);
  c.observe(0.32, 5);
  c.observe(0.15, 6.2);
  expect(c.lastProgress).toBe(6.2);
  expect(c.expiry(6.2)).toBeNull();
  c.hop(4, 7);
  c.observe(3, 8);
  c.observe(2, 10);
  c.observe(1, 12);
  expect(c.expiry(12.1)).toBe("cap");
});
it("expires actual commanded stationary motion at3s and moving oscillation at12s", () => {
  const stationary = new DetourProgress(4, 0);
  for (let i = 0; i < 59; i++) stationary.motion(1, 0, 0.05);
  expect(stationary.expiry(2.95)).toBeNull();
  stationary.motion(1, 0, 0.05);
  expect(stationary.expiry(3)).toBe("stall");
  const moving = new DetourProgress(4, 0);
  for (let i = 0; i < 240; i++) {
    moving.observe(i % 2 ? 4 : 3.9, i * 0.05);
    moving.motion(1, 0.01, 0.05);
  }
  expect(moving.expiry(11.95)).toBeNull();
  expect(moving.expiry(12)).toBe("cap");
  const hover = new DetourProgress(4, 0);
  for (let i = 0; i < 60; i++) hover.motion(0, 0, 0.05);
  expect(hover.expiry(3)).toBeNull();
});
