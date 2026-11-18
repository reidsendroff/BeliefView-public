import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  buildWorld,
  simulateGuided,
} from "../src/sim/simulate";
import { simulatePolicy } from "../src/sim/policyRuntime";
import {
  buildRichWorld,
  subjectNavigationWorld,
  inWater,
} from "../src/sim/richWorld";
import { lineOfSight, segmentHitsSphere } from "../src/sim/geometry";
import { ActiveSearchGuidance } from "../src/ml/activeGuidance";
import { Navigation } from "../src/ml/navigation";
import { loadModel } from "./ml/helpers";
import type { World } from "../src/sim/world";

describe("versioned policy boundary", () => {
  it("reproduces original learned baseline frames exactly", async () => {
    const m = await loadModel(),
      w = buildWorld(DEFAULT_CONFIG);
    const a = await simulateGuided(DEFAULT_CONFIG, w, (f) => m.predict(f)),
      b = await simulatePolicy(DEFAULT_CONFIG, w, "baseline", (f) =>
        m.predict(f),
      );
    expect(b.frames).toEqual(a.frames);
    expect(b.ml).toEqual(a.ml);
  }, 120000);
  it("ignores throwing hidden getters on narrow sensor input", () => {
    const w = buildWorld(DEFAULT_CONFIG),
      g = new ActiveSearchGuidance(w),
      step = {
        t: 1,
        obs: null,
        drone: { x: 0, y: 4, z: 0, camYaw: 0, camPitch: 0 },
      };
    const guarded = new Proxy(step, {
      get(t, k, r) {
        if (
          ["subject", "visibility", "action", "cover", "intent"].includes(
            String(k),
          )
        )
          throw Error("leak");
        return Reflect.get(t, k, r);
      },
    });
    expect(() => g.observe(guarded)).not.toThrow();
  });
});
describe("rich physical map", () => {
  const w = buildRichWorld(DEFAULT_CONFIG);
  it("contains deterministic tagged real cover, with matching nonzero spherical geometry", () => {
    expect(w.covers.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["boulder", "log", "bush", "leaf-pile"]),
    );
    expect(buildRichWorld(DEFAULT_CONFIG).covers).toEqual(w.covers);
    for (const c of w.covers)
      for (const i of c.primitives)
        expect(w.trees[i].canopyR).toBeGreaterThan(0);
  });
  it("pond barriers are navigation-only and do not hide a crouched target", () => {
    const nav = subjectNavigationWorld(w);
    expect(nav.trees.length).toBeGreaterThan(w.trees.length);
    const p = w.ponds[0],
      a = { x: p.x - p.radius - 3, y: p.level + 0.65, z: p.z },
      b = { x: p.x + p.radius + 3, y: p.level + 0.65, z: p.z };
    const waterOnly = {
      ...nav,
      trees: nav.trees.slice(w.trees.length),
      heightAt: () => p.level,
    };
    expect(lineOfSight(waterOnly, a, b)).toBe("NONE");
    expect(inWater(w, p.x, p.z)).toBe(true);
  });
  it("low mound geometry can hide crouched torso but not standing torso at level observation angles", () => {
    const center = { x: 0, y: 0, z: 0 };
    expect(
      segmentHitsSphere(
        { x: 0, y: 0.65, z: -5 },
        { x: 0, y: 0.65, z: 5 },
        center,
        1.1,
      ),
    ).toBe(true);
    expect(
      segmentHitsSphere(
        { x: 0, y: 1.3, z: -5 },
        { x: 0, y: 1.3, z: 5 },
        center,
        1.1,
      ),
    ).toBe(false);
  });
  it("routes around solid cover with every returned segment clear", () => {
    const flat: World = {
      seed: 1,
      half: 20,
      heightAt: () => 0,
      rocks: [],
      trees: [
        {
          x: 0,
          z: 0,
          groundY: 0,
          trunkR: 2,
          trunkTop: 7,
          canopyY: 10,
          canopyR: 0,
          hue: 0,
          grove: false,
        },
      ],
    };
    const n = new Navigation(flat),
      r = n.paths({ x: -8, z: 0 }, [{ x: 8, z: 0 }])[0];
    expect(r).not.toBeNull();
    expect(r!.path.length).toBeGreaterThan(2);
    for (let i = 1; i < r!.path.length; i++)
      expect(n.clearSegment(r!.path[i - 1], r!.path[i])).toBe(true);
    expect(r!.distance).toBeGreaterThan(16);
  });
  it("rich subject never enters pond across full baseline episode", async () => {
    const m = await loadModel(),
      tl = await simulatePolicy(DEFAULT_CONFIG, w, "baseline", (f) =>
        m.predict(f),
      );
    expect(
      tl.frames.filter((f) => inWater(w, f.subject.x, f.subject.z)),
    ).toHaveLength(0);
  }, 120000);
});

describe("reference terrain and evidence boundaries", () => {
  it("has mature trunks, saplings, low evergreen foliage and extra relief without changing original world", () => {
    const old = buildWorld(DEFAULT_CONFIG),
      w = buildRichWorld(DEFAULT_CONFIG);
    expect(w.trees.some((t) => t.trunkR >= 0.6)).toBe(true);
    expect(w.trees.some((t) => t.trunkR > 0 && t.trunkR < 0.22)).toBe(true);
    expect(
      w.trees.some(
        (t) => (t as any).evergreen && t.canopyY - t.groundY - t.canopyR < 0.5,
      ),
    ).toBe(true);
    expect(
      w.trees.some(
        (t, i) =>
          !("coverKind" in t) &&
          w.trees
            .slice(i + 1)
            .some(
              (u) =>
                !("coverKind" in u) &&
                Math.hypot(t.x - u.x, t.z - u.z) > 1 &&
                Math.hypot(t.x - u.x, t.z - u.z) < 2.6,
            ),
      ),
    ).toBe(true);
    expect(Math.abs(w.heightAt(0, 0) - old.heightAt(0, 0))).toBeGreaterThan(
      0.05,
    );
    expect(buildWorld(DEFAULT_CONFIG).trees).toEqual(old.trees);
  });
  it("terrain ridge blocks a low ray while a raised ray clears it", () => {
    const w: World = {
      seed: 1,
      half: 20,
      rocks: [],
      trees: [],
      heightAt: (x) => 3 * Math.exp((-x * x) / 6),
    };
    expect(lineOfSight(w, { x: -8, y: 1, z: 0 }, { x: 8, y: 1, z: 0 })).toBe(
      "TERRAIN",
    );
    expect(lineOfSight(w, { x: -8, y: 5, z: 0 }, { x: 8, y: 5, z: 0 })).toBe(
      "NONE",
    );
  });
});

describe("low-cover selection and narrow planner input", () => {
  it("selects a log and bush only when each chosen object's own geometry shields the intended crouched spot", async () => {
    const { RichSubjectAgent } = await import("../src/sim/richSubject");
    for (const kind of ["log", "bush"] as const) {
      const radius = kind === "log" ? 0.65 : 1.1;
      const tree = {
        x: 0,
        z: 0,
        groundY: 0,
        trunkR: radius,
        trunkTop: 0,
        canopyR: radius,
        canopyY: kind === "log" ? radius * 0.65 : radius * 0.2,
        hue: 0,
        grove: false,
        coverKind: kind,
        coverId: 0,
      };
      const w: World = {
        seed: 1,
        half: 40,
        trees: [tree],
        rocks: [],
        heightAt: () => 0,
      };
      const a = new RichSubjectAgent(
        w,
        [
          [-5, 3],
          [10, 10],
        ],
        123,
        0.05,
      ) as any;
      a.percept = { x: 0, y: 2, z: -30 };
      const spot = a.findCover();
      expect(spot).not.toBeNull();
      expect(lineOfSight(w, a.percept, { x: spot.x, z: spot.z, y: 0.65 })).toBe(
        "CANOPY",
      );
      expect(lineOfSight(w, a.percept, { x: spot.x, z: spot.z, y: 1.3 })).toBe(
        "NONE",
      );
      expect(Math.hypot(spot.x, spot.z)).toBeGreaterThan(radius + 0.3);
    }
  });
  it("does real scoring with throwing truth getters and records only actual empty sensor views", async () => {
    const { makeDrone } = await import("../src/sim/drone");
    const w: World = {
      seed: 1,
      half: 40,
      trees: [],
      rocks: [],
      heightAt: () => 0,
    };
    const g = new ActiveSearchGuidance(w),
      prob = new Float32Array(1024).fill(1 / 1024);
    g.setBelief({ i: 1, t: 1, center: { x: 0, z: 0 }, elapsed: 9, prob });
    const guard = (x: any) =>
      new Proxy(x, {
        get(o, k, r) {
          if (
            [
              "subject",
              "visibility",
              "action",
              "posture",
              "cover",
              "intent",
            ].includes(String(k))
          )
            throw Error("truth access");
          return Reflect.get(o, k, r);
        },
      });
    const d = makeDrone(w, { x: 0, z: -10 }, { x: 0, z: 0 });
    d.pos.y = 3;
    const before = g.stats.sensedCells;
    expect(() => g.chooseViewpoint(w, guard(d))).not.toThrow();
    expect(g.stats.sensedCells).toBe(before);
    g.observe(
      guard({
        t: 1,
        obs: null,
        drone: { x: 0, y: 3, z: -10, camYaw: 0, camPitch: -0.15 },
      }),
    );
    expect(g.stats.sensedCells).toBeGreaterThan(before);
    expect(prob.every((v) => v === 1 / 1024)).toBe(true);
  });
});

it("rich collision corrections remain outside overlapping solid footprints without jumps", async () => {
  const { RichSubjectAgent } = await import("../src/sim/richSubject");
  const { SUBJECT } = await import("../src/sim/subject");
  const tree = (x: number, z: number) => ({
    x,
    z,
    groundY: 0,
    trunkR: 1.1,
    trunkTop: 4,
    canopyR: 0,
    canopyY: 10,
    hue: 0,
    grove: false,
  });
  const w: World = {
    seed: 1,
    half: 30,
    heightAt: () => 0,
    rocks: [],
    trees: [tree(-0.8, 0), tree(0.8, 0.3)],
  };
  const agent = new RichSubjectAgent(
    w,
    [
      [0, -6],
      [0, 8],
    ],
    31,
    0.05,
  );
  for (let i = 0; i < 500; i++) {
    const before = agent.snapshot();
    agent.step({ x: 100, y: 3, z: 100 }, 0.05);
    const after = agent.snapshot();
    expect(
      Math.hypot(after.x - before.x, after.z - before.z),
    ).toBeLessThanOrEqual(SUBJECT.sprintMax * 0.05 + 0.081);
    for (const t of w.trees)
      expect(Math.hypot(after.x - t.x, after.z - t.z)).toBeGreaterThanOrEqual(
        t.trunkR + SUBJECT.trunkHardMargin - 1e-6,
      );
  }
});

it("rich sphere and cylinder display approximations have bounded silhouette mismatch", async () => {
  const THREE = await import("three");
  const { Rng } = await import("../src/sim/rng");
  const { segmentHitsCylinder } = await import("../src/sim/geometry");
  const rng = new Rng(53),
    ray = new THREE.Raycaster();
  const sphere = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 3),
    new THREE.MeshBasicMaterial(),
  );
  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 3, 24).translate(0, 1.5, 0),
    new THREE.MeshBasicMaterial(),
  );
  sphere.updateMatrixWorld();
  cylinder.updateMatrixWorld();
  let disagreements = 0;
  for (let i = 0; i < 2000; i++) {
    const a = new THREE.Vector3(rng.range(-1.4, 1.4), rng.range(-1.4, 3.8), -5),
      b = new THREE.Vector3(a.x, a.y, 5);
    ray.set(a, b.clone().sub(a).normalize());
    ray.far = 10;
    const analyticSphere = segmentHitsSphere(a, b, { x: 0, y: 0, z: 0 }, 1),
      analyticCylinder = segmentHitsCylinder(a, b, 0, 0, 1, 0, 3);
    disagreements += Number(
      analyticSphere !== ray.intersectObject(sphere).length > 0,
    );
    disagreements += Number(
      analyticCylinder !== ray.intersectObject(cylinder).length > 0,
    );
  }
  expect(disagreements / 4000).toBeLessThan(0.015);
});
