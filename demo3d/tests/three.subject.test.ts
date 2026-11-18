import { describe, expect, it } from "vitest";
import { ThreeSubjectAgent } from "../src/team/threeSubject";
import { ThreePerception } from "../src/team/threePerception";
import {
  ThreeGeometry,
  convexFromPlanes,
  type ThreeWorld,
} from "../src/team/threeGeometry";
import { bodyPose, BODY } from "../src/team/threeBody";
import { bodyDetection } from "../src/team/threeSensing";
import { certifyTerrain } from "../src/team/clearance";
const flat = () => 0;
certifyTerrain(flat, 0);
const world = (): ThreeWorld => ({
  seed: 1,
  half: 95,
  trees: [],
  rocks: [],
  heightAt: flat,
  n3WorldVersion: "fixture",
  n3Solids: [],
  n3Covers: [],
});
const cue = { id: "A" as const, sensedAt: 0, position: { x: -8, y: 2, z: 0 } };
const choice = () => ({
  object: {
    id: "cover",
    kind: "tree",
    x: 0,
    z: 0,
    radius: 1,
    length: 0,
    yaw: 0,
    treeIndices: [],
    solidIds: [],
  },
  point: { x: 0, z: 0 },
  approach: { x: 0, z: 0 },
  heading: 0,
  posture: "prone",
  score: 1,
  fully: 1,
  path: [],
  distance: 0,
});
describe("purposeful N3 cover transitions", () => {
  it("abandons an entirely exposed selected object with live degraded cues", () => {
    const a: any = new ThreeSubjectAgent(
      world(),
      [
        [0, 0],
        [0, 15],
      ],
      1,
    );
    a.selected = choice();
    a.behavior = "holding-cover";
    a.perception.observe = () => [cue];
    a.score = () => null;
    a.chooseCover = () => false;
    a.step([], 0.05);
    expect(a.snapshot().coverObjectId).toBe(null);
    expect(a.snapshot().intentionalHold).toBe(false);
    expect(a.snapshot().routeReason).toBe("Perceived cover no longer useful");
  });
  it("caps attempted rejected cover candidates, not just accepted finalists", () => {
    const w = world();
    w.n3Covers = Array.from(
      { length: 16 },
      (_, i) => ({ ...choice().object, id: "tree" + i, x: i * 0.5 }) as any,
    );
    const a: any = new ThreeSubjectAgent(
      w,
      [
        [0, 0],
        [0, 15],
      ],
      1,
    );
    a.cues = [cue];
    a.score = () => null;
    a.chooseCover();
    expect(a.stats.candidates).toBe(96);
  });
  it("finishes a close cover approach instead of discarding its last waypoint too early", () => {
    const a: any = new ThreeSubjectAgent(
      world(),
      [
        [0, 0],
        [0, 15],
      ],
      1,
    );
    a.selected = {
      ...choice(),
      point: { x: 0, z: 0.22 },
      approach: { x: 0, z: 2 },
      posture: "crouched",
    };
    a.behavior = "approach-cover";
    a.path = [{ x: 0, z: 0.22 }];
    a.posture = { from: "crouched", to: "crouched", progress: 1 };
    a.perception.observe = () => [cue];
    a.score = () => ({ score: 1, fully: 1 });
    for (let k = 0; k < 30; k++) a.step([], 0.05);
    expect(a.snapshot().intentionalHold).toBe(true);
    expect(a.stats.routeFailures).toBe(0);
  });
  it("keeps the chosen log-parallel heading through a lateral prone crawl", () => {
    const a: any = new ThreeSubjectAgent(
      world(),
      [
        [0, 0],
        [0, 15],
      ],
      1,
    );
    a.selected = {
      ...choice(),
      point: { x: 0, z: 0.5 },
      approach: { x: 0, z: 2 },
      heading: Math.PI / 2,
    };
    a.heading = Math.PI / 2;
    a.behavior = "approach-cover";
    a.path = [{ x: 0, z: 0.5 }];
    a.posture = { from: "prone", to: "prone", progress: 1 };
    a.perception.observe = () => [cue];
    a.score = () => ({ score: 1, fully: 1 });
    for (let k = 0; k < 10; k++) a.step([], 0.05);
    expect(a.snapshot().heading).toBeCloseTo(Math.PI / 2, 10);
    expect(a.snapshot().z).toBeGreaterThan(0.2);
  });
  it("completes envelope reconnection before retiring its last waypoint", () => {
    const a: any = new ThreeSubjectAgent(
      world(),
      [
        [0, 0],
        [0, 15],
      ],
      1,
    );
    a.escapingPose = true;
    a.path = [{ x: 0, z: 0.5 }];
    a.nav.free = (_x: number, z: number) => z >= 0.48;
    for (let k = 0; k < 20 && a.escapingPose; k++) a.step([], 0.05);
    expect(a.snapshot().z).toBeGreaterThanOrEqual(0.48);
    expect(a.escapingPose).toBe(false);
  });
  it("does not let nearest trees starve all other cover kinds", () => {
    const w = world();
    w.n3Covers = [
      ...Array.from({ length: 25 }, (_, i) => ({
        ...choice().object,
        id: "tree" + i,
        x: i * 0.1,
      })),
      { ...choice().object, id: "boulder", kind: "boulder", x: 8 },
      { ...choice().object, id: "log", kind: "log", x: 9, length: 6 },
    ] as any;
    const a: any = new ThreeSubjectAgent(
        w,
        [
          [0, 0],
          [0, 15],
        ],
        1,
      ),
      seen = new Set<string>();
    a.cues = [cue];
    a.score = (_p: any, _h: any, _s: any, o: any) => {
      if (o) seen.add(o.id);
      return null;
    };
    a.chooseCover();
    expect(seen.has("boulder")).toBe(true);
    expect(seen.has("log")).toBe(true);
    expect(a.stats.candidates).toBeLessThanOrEqual(96);
  });
  it("does not award route progress when an obstructed movement clears its path", () => {
    const a: any = new ThreeSubjectAgent(
      world(),
      [
        [0, 0],
        [0, 15],
      ],
      1,
    );
    a.path = [{ x: 0, z: 20 }];
    a.bestRemaining = 20;
    a.swept = () => false;
    a.step([], 0.05);
    expect(a.snapshot().routeProgressTotalM).toBe(0);
    expect(a.snapshot().z).toBe(0);
    expect(a.stats.routeFailures).toBe(1);
  });
  it.each(["turn", "lower"])(
    "bounds rejected %s early returns by the posture watchdog",
    (mode) => {
      const a: any = new ThreeSubjectAgent(
        world(),
        [
          [0, 0],
          [0, 15],
        ],
        1,
      );
      a.selected = choice();
      a.selected.heading = mode === "turn" ? Math.PI : 0;
      a.perception.observe = () => [cue];
      a.score = () => ({ score: 1, fully: 1 });
      a.swept = () => false;
      for (let k = 0; k < 60; k++) a.step([], 0.05);
      expect(a.snapshot().coverObjectId).toBe(null);
      expect(a.snapshot().behavior).toBe("route-blocked");
      expect(a.snapshot().routeReason).toBe(
        "No collision-free posture recovery found",
      );
    },
  );
});
describe("physical prone log concealment and planted limbs", () => {
  it("occludes the entire prone body from a low side view and exposes it from above", () => {
    const w = world();
    w.n3Solids = [
      convexFromPlanes({ id: "log", objectId: "log", kind: "log" }, [
        { normal: { x: 1, y: 0, z: 0 }, offset: 0.45 },
        { normal: { x: -1, y: 0, z: 0 }, offset: 0.45 },
        { normal: { x: 0, y: 1, z: 0 }, offset: 1 },
        { normal: { x: 0, y: -1, z: 0 }, offset: 0 },
        { normal: { x: 0, y: 0, z: 1 }, offset: 3 },
        { normal: { x: 0, y: 0, z: -1 }, offset: 3 },
      ]),
    ];
    const g = new ThreeGeometry(w),
      body = {
        root: { x: 0.95, y: 0, z: 0 },
        heading: 0,
        gait: 0,
        speed: 0,
        posture: { from: "prone" as const, to: "prone" as const, progress: 1 },
      };
    expect(g.bodyValid(bodyPose(body, w))).toBe(true);
    const view = (x: number, y: number, z: number) => {
      const dx = body.root.x - x,
        dz = -z;
      return bodyDetection(
        g,
        {
          pos: { x, y, z },
          camYaw: Math.atan2(dx, dz),
          camPitch: Math.atan2(0.25 - y, Math.hypot(dx, dz)),
        },
        body,
      );
    };
    expect(view(-8, 1.2, 0).geometricallyBlockedSamples).toBe(9);
    expect(view(-8, 1.2, 0).detected).toBe(false);
    expect(view(0.95, 10, 0).detected).toBe(true);
  });
  it("rejects an elevated root and plants completed kneeling knees", () => {
    const input = {
      root: { x: 0, y: 0, z: 0 },
      heading: 0,
      gait: 0,
      speed: 0,
      posture: {
        from: "kneeling" as const,
        to: "kneeling" as const,
        progress: 1,
      },
    };
    const p = bodyPose(input, { heightAt: flat });
    expect(p.groundingValid).toBe(true);
    expect(p.joints.kneeL.y).toBeCloseTo(BODY.legRadius, 7);
    expect(p.joints.kneeR.y).toBeCloseTo(BODY.legRadius, 7);
    expect(
      bodyPose({ ...input, root: { x: 0, y: 100, z: 0 } }, { heightAt: flat })
        .groundingValid,
    ).toBe(false);
  });
  it("keeps a stance foot planted while root travel advances the distance-based cycle", () => {
    const make = (distance: number) =>
      bodyPose(
        {
          root: { x: 0, y: 0, z: distance },
          heading: 0,
          gait: distance,
          speed: 3,
          posture: { from: "standing", to: "standing", progress: 1 },
        },
        { heightAt: flat },
      );
    const a = make(0.1),
      b = make(0.4);
    expect(a.groundingValid && b.groundingValid).toBe(true);
    expect(a.joints.footL.z).toBeCloseTo(b.joints.footL.z, 9);
    expect(a.joints.footL.y).toBeCloseTo(b.joints.footL.y, 9);
  });
});
describe("separate delayed subject perception", () => {
  it("uses canonical independent histories and never reads hidden fields", () => {
    const one = new ThreePerception(12),
      two = new ThreePerception(12);
    const positions = ["A", "B", "C"].map((id, i) => ({
      id: id as "A" | "B" | "C",
      position: { x: i * 10, y: 4, z: 0 },
      get subject() {
        throw Error("forbidden");
      },
      get camYaw() {
        throw Error("forbidden");
      },
    }));
    for (let k = 0; k <= 40; k++) {
      const t = k * 0.05,
        a = one.observe(positions, { x: 0, z: 0 }, t),
        b = two.observe([...positions].reverse(), { x: 0, z: 0 }, t);
      expect(a).toEqual(b);
      if (t < 0.8) expect(a).toEqual([]);
      for (const c of a) expect(c.sensedAt).toBeLessThanOrEqual(t - 0.8 + 1e-8);
    }
    expect(one.observe([], { x: 0, z: 0 }, 5)).toEqual([]);
  });
});
