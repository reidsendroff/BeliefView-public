import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TeamRecovery, detourPath, recoveryTarget, DetourProgress } from "../src/team/recovery";
import { certifyTerrain, validMotion } from "../src/team/clearance";
import { sweptSeparation } from "../src/team/separation";
import { makeDrone } from "../src/sim/drone";
import { buildPublicScenario } from "../src/team/scenario";
import type { World } from "../src/sim/world";
const flat = () => 0;
certifyTerrain(flat, 0);
const w: World = { seed: 1, half: 95, heightAt: flat, trees: [], rocks: [] };
const distance = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function pair() {
  return (
    [
      ["A", 0],
      ["B", 4.5],
    ] as const
  ).map(([id, x]) => {
    const state = makeDrone(w, { x, z: 0 }, { x: 0, z: 10 });
    state.pos.y = 3;
    state.vel = { x: 0, y: 0, z: 0 };
    return { id, state };
  });
}
describe("extended local recovery reservations", () => {
  it("preserves ordinary2/4m selection and finds the recorded narrow-pocket short escape", () => {
    const p = { x: 0, y: 3, z: 0 },
      command = { x: 0, y: 0, z: 1 };
    expect(detourPath(w, p, command, true, { shortFallback: true })).toEqual(
      detourPath(w, p, command, true),
    );
    const f = JSON.parse(
        readFileSync("tests/fixtures/team-long-pocket.json", "utf8"),
      ),
      world = buildPublicScenario(f.seed, f.family).world;
    const d = f.aircraft.find((a: any) => a.id === "B"),
      c = f.commandedMotion.find((a: any) => a.id === "B").displacement;
    expect(detourPath(world, d.state.pos, c, true)).toBeNull();
    const path = detourPath(world, d.state.pos, c, true, {
      shortFallback: true,
    })!;
    expect(path).not.toBeNull();
    expect(distance(d.state.pos, path.at(-1)!)).toBeGreaterThanOrEqual(
      0.650001 - 1e-9,
    );
    let last = d.state.pos;
    for (const q of path) {
      expect(validMotion(world, last, q)).toBe(true);
      last = q;
    }
  });
  it("reserves live goals deterministically regardless of source-array order", () => {
    const results = [];
    for (const reverse of [false, true]) {
      const r = new TeamRecovery(true),
        before = pair();
      if (reverse) before.reverse();
      const after = structuredClone(before);
      for (const d of after) d.state.pos.y = 1;
      r.apply(w, before, after, 0, 0.05);
      const states = r.snapshot().sort((a, b) => a.id.localeCompare(b.id));
      expect(states.every((s) => s.target !== null)).toBe(true);
      expect(
        distance(states[0].target!, states[1].target!),
      ).toBeGreaterThanOrEqual(4.5);
      results.push(states);
    }
    expect(results[0]).toEqual(results[1]);
  });
  it("honors an earlier B reservation when A requests a detour later", () => {
    const r = new TeamRecovery(true),
      before = pair(),
      after = structuredClone(before);
    after[1].state.pos.y = 1;
    r.apply(w, before, after, 0, 0.05);
    const b = r.snapshot().find((s) => s.id === "B")!.target!;
    const next = structuredClone(before);
    next[0].state.pos.y = 1;
    r.apply(w, before, next, 0.05, 0.05);
    const a = r.snapshot().find((s) => s.id === "A")!.target!;
    expect(distance(a, b)).toBeGreaterThanOrEqual(4.5);
  });
  it("rejects a held-peer interior crossing with valid separated endpoints", () => {
    const p = { x: -2, y: 3, z: -3.5 },
      held = { x: 0, y: 3, z: 0 },
      command = { x: 1, y: 0, z: 0 };
    const unreserved = detourPath(w, p, command, true)!;
    expect(distance(p, held)).toBeGreaterThan(4);
    expect(distance(unreserved[0], held)).toBeGreaterThan(4);
    expect(
      sweptSeparation(
        { pos: p },
        { pos: unreserved[0] },
        { pos: held },
        { pos: held },
      ),
    ).toBeLessThan(4);
    const reserved = detourPath(w, p, command, true, {
      shortFallback: true,
      stationary: [held],
    })!;
    expect(reserved).not.toBeNull();
    let start = p;
    for (const q of reserved) {
      expect(
        sweptSeparation(
          { pos: start },
          { pos: q },
          { pos: held },
          { pos: held },
        ),
      ).toBeGreaterThanOrEqual(4 - 1e-8);
      start = q;
    }
  });
  it("also applies waypoint reservations to genuine deficit recovery", () => {
    const world = {
      ...w,
      trees: [
        {
          x: 0,
          z: 0,
          groundY: 0,
          trunkR: 1,
          trunkTop: 10,
          canopyR: 0,
          canopyY: 20,
          hue: 0,
          grove: false,
        },
      ],
    };
    const p = { x: 1.95, y: 3, z: 0 },
      old = recoveryTarget(world, p)!;
    const target = recoveryTarget(world, p, {
      waypoints: [old],
      shortFallback: true,
    })!;
    expect(target).not.toBeNull();
    expect(distance(target, old)).toBeGreaterThanOrEqual(4.5);
    expect(validMotion(world, p, target)).toBe(true);
  });
  it("does not inspect hidden getters in extended public motion inputs", () => {
    const r = new TeamRecovery(true),
      before = pair(),
      after = structuredClone(before);
    for (const obj of [
      w,
      ...before,
      ...before.map((d) => d.state),
      ...before.map((d) => d.state.pos),
    ])
      Object.defineProperty(obj, "hiddenSubject", {
        get() {
          throw Error("truth");
        },
        configurable: true,
      });
    after[0].state.pos.y = 1;
    expect(() => r.apply(w, before, after, 0, 0.05)).not.toThrow();
    delete (w as unknown as Record<string, unknown>).hiddenSubject;
  });
  it("bounds reservation wait once, ignores stale blocked paths, and resumes after availability", () => {
    const r = new TeamRecovery(true),
      before = pair();
    before[1].state.pos.x = 80;
    const internal = r as any;
    const points = [];
    for (let x = -4; x <= 4; x += 2)
      for (let z = -4; z <= 4; z += 2) points.push({ x, y: 3, z });
    internal.states.set("B", {
      id: "B",
      state: "recovering",
      since: 0,
      target: points[0],
      reason: "fixture existing reservation",
      deficitM: 0,
    });
    internal.latches.set("B", {
      origin: { x: 80, y: 3, z: 0 },
      path: points,
      contact: true,
      retries: 0,
      clock: new DetourProgress(80, 0),
      extended: false,
      pairConstrained: false,
    });
    for (let i = 0; i <= 100; i++) {
      const after = structuredClone(before);
      after[0].state.pos.y = 1;
      r.apply(w, before, after, i * 0.05, 0.05);
    }
    expect(r.extendedStats!.reservationWaitTimeouts).toBe(1);
    expect(r.snapshot().find((s) => s.id === "A")!.state).toBe("blocked");
    const count = r.stats.blockedEvents;
    internal.states.get("B").state = "blocked";
    internal.states.get("B").target = null;
    const after = structuredClone(before);
    after[0].state.pos.y = 1;
    r.apply(w, before, after, 6.1, 0.05);
    expect(r.snapshot().find((s) => s.id === "A")!.state).toBe("recovering");
    expect(r.stats.blockedEvents).toBe(count);
  });
});
