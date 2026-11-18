import { describe, it, expect } from "vitest";
import {
  bodyPose,
  BODY,
  SAMPLE_IDS,
  type Posture,
} from "../src/team/threeBody";
import {
  ThreeGeometry,
  convexFromPlanes,
  convexClearance,
  triangleHitsCylinder,
  type ThreeWorld,
} from "../src/team/threeGeometry";
import { certifyTerrain } from "../src/team/clearance";
import { fovTest } from "../src/sim/sensor";
const flat = () => 0;
certifyTerrain(flat, 0);
const box = convexFromPlanes({ id: "b1", objectId: "rock", kind: "boulder" }, [
  { normal: { x: 1, y: 0, z: 0 }, offset: 1 },
  { normal: { x: -1, y: 0, z: 0 }, offset: 1 },
  { normal: { x: 0, y: 1, z: 0 }, offset: 2 },
  { normal: { x: 0, y: -1, z: 0 }, offset: 1 },
  { normal: { x: 0, y: 0, z: 1 }, offset: 1 },
  { normal: { x: 0, y: 0, z: -1 }, offset: 1 },
  { normal: { x: 1, y: 1, z: 0 }, offset: 2.5 },
]);
function world(solids = [box]): ThreeWorld {
  return {
    seed: 1,
    half: 95,
    trees: [],
    rocks: [],
    heightAt: flat,
    n3WorldVersion: "fixture",
    n3Solids: solids,
    n3Covers: [],
  };
}
const postures: Posture[] = ["standing", "crouched", "kneeling", "prone"];
describe("one articulated N3 body contract", () => {
  it("has grounded fixed-length knees/elbows and exact nine samples across flat transitions", () => {
    for (const from of postures)
      for (const to of postures)
        for (let i = 0; i <= 20; i++) {
          const p = bodyPose(
            {
              root: { x: 2, y: 0, z: 3 },
              heading: 0.73,
              gait: 1.2,
              speed: 0,
              posture: { from, to, progress: i / 20 },
            },
            { heightAt: flat },
          );
          expect(
            p.groundingValid,
            from + "->" + to + ":" + i + ":" + p.invalidReason,
          ).toBe(true);
          expect(p.samples.map((s) => s.id)).toEqual(SAMPLE_IDS);
          expect(p.joints.pelvis.x).toBe(2);
          expect(p.joints.pelvis.z).toBe(3);
          expect(p.joints.pelvis.y).toBeGreaterThanOrEqual(BODY.minPelvis);
          expect(p.joints.pelvis.y).toBeLessThanOrEqual(BODY.maxPelvis);
          for (const side of ["L", "R"] as const)
            for (const [a, b, n] of [
              ["hip", "knee", BODY.upperLeg],
              ["knee", "foot", BODY.lowerLeg],
              ["shoulder", "elbow", BODY.upperArm],
              ["elbow", "hand", BODY.lowerArm],
            ] as const) {
              const x = p.joints[(a + side) as keyof typeof p.joints],
                y = p.joints[(b + side) as keyof typeof p.joints];
              expect(Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z)).toBeCloseTo(
                n,
                7,
              );
            }
          expect(p.samples[0].point.y - p.joints.head.y).toBeCloseTo(
            BODY.headRadius,
            10,
          );
        }
  });
  it("supports actual running gait on every tested heading at modest slopes", () => {
    for (const degrees of [-20, -10, -5, 0, 5, 10, 20])
      for (let h = 0; h < 16; h++)
        for (let g = 0; g < 24; g++) {
          const slope = Math.tan((degrees * Math.PI) / 180),
            p = bodyPose(
              {
                root: { x: 0, y: 0, z: 0 },
                heading: (h * Math.PI) / 8,
                gait: (g * Math.PI) / 12,
                speed: 3,
                posture: { from: "standing", to: "standing", progress: 1 },
              },
              { heightAt: (x: number) => x * slope },
            );
          expect(
            p.groundingValid,
            degrees + ":" + h + ":" + g + ":" + p.invalidReason,
          ).toBe(true);
          expect(p.joints.pelvis.x).toBe(0);
          expect(p.joints.pelvis.z).toBe(0);
        }
  });
  it("returns finite invalid data for malformed inputs or terrain", () => {
    for (const [x, height] of [
      [NaN, () => 0],
      [0, () => NaN],
    ] as const) {
      const p = bodyPose(
        {
          root: { x, y: 0, z: 0 },
          heading: 0,
          gait: 0,
          speed: 0,
          posture: { from: "prone", to: "prone", progress: 1 },
        },
        { heightAt: height },
      );
      expect(p.groundingValid).toBe(false);
      expect(
        Object.values(p.joints).every((q) =>
          [q.x, q.y, q.z].every(Number.isFinite),
        ),
      ).toBe(true);
    }
  });
});
describe("shared convex physical and visibility geometry", () => {
  it("derives mesh faces from exact planes and preserves physical versus inflated contact", () => {
    expect(box.vertices.length).toBeGreaterThan(7);
    expect(box.faces.length).toBe(7);
    for (const p of box.vertices)
      expect(convexClearance(box, p)).toBeLessThanOrEqual(1e-7);
    const g = new ThreeGeometry(world()),
      a = { x: 2, y: 1, z: 0 };
    expect(g.extraValidMotion(a, { x: 2, y: 1, z: 0.5 }, 1)).toBe(true);
    expect(g.extraValidMotion(a, { x: 1.9, y: 1, z: 0 }, 1)).toBe(false);
    expect(
      g.extraPhysicalMotion({ x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }),
    ).toBe(false);
    expect(
      g.extraValidMotion({ x: 1.95, y: 1, z: 0 }, { x: 2.2, y: 1, z: 0 }, 1),
    ).toBe(true);
    expect(
      g.extraValidMotion({ x: -1.95, y: 1, z: 0 }, { x: 2.2, y: 1, z: 0 }, 1),
    ).toBe(false);
  });
  it("handles the vertical triangle projected segment and capped cylinder", () => {
    const a = { x: 0, y: 3, z: -10 },
      b = { x: 0, y: 0.15, z: 0 },
      c = { x: 0, y: 1.25, z: 0 };
    expect(triangleHitsCylinder(a, b, c, 0, -5, 0.5, 0, 4)).toBe(true);
    expect(triangleHitsCylinder(a, b, c, 2, -5, 0.5, 0, 4)).toBe(false);
    expect(triangleHitsCylinder(a, b, c, 0, -5, 0.5, 5, 6)).toBe(false);
  });
  it("retains negative credit behind cover and certifies open columns", () => {
    const camera = { x: 0, y: 2, z: -10, yaw: 0, pitch: -0.05 },
      root = { x: 0, z: 2 };
    expect(new ThreeGeometry(world()).visiblePelvisColumn(camera, root)).toBe(
      false,
    );
    expect(new ThreeGeometry(world([])).visiblePelvisColumn(camera, root)).toBe(
      true,
    );
  });
  it("certified columns imply visible samples for every valid randomized pose", () => {
    const g = new ThreeGeometry(world([])),
      camera = { x: 0, y: 3, z: -12, yaw: 0, pitch: -0.2 };
    let certified = 0;
    for (let i = 0; i < 200; i++) {
      const root = { x: Math.sin(i) * 2, y: 0, z: Math.cos(i) * 2 };
      if (!g.visiblePelvisColumn(camera, root)) continue;
      certified++;
      const p = bodyPose(
        {
          root,
          heading: i * 0.713,
          gait: i * 0.23,
          speed: 1,
          posture: {
            from: postures[i % 4],
            to: postures[(i >> 2) % 4],
            progress: (i % 21) / 20,
          },
        },
        { heightAt: flat },
      );
      if (!p.groundingValid) continue;
      expect(
        p.samples.some((s) => {
          const f = fovTest(camera, camera.yaw, camera.pitch, s.point);
          return (
            f.inFov && f.inRange && g.lineOfSight(camera, s.point) === "NONE"
          );
        }),
      ).toBe(true);
    }
    expect(certified).toBeGreaterThan(100);
  });
  it("rejects opaque foliage-only and convex body interiors", () => {
    const p = bodyPose(
      {
        root: { x: 0, y: 0, z: 0 },
        heading: 0,
        gait: 0,
        speed: 0,
        posture: { from: "prone", to: "prone", progress: 1 },
      },
      { heightAt: flat },
    );
    expect(new ThreeGeometry(world()).bodyValid(p)).toBe(false);
    const w = world([]);
    w.trees.push({
      x: 0,
      z: 0,
      groundY: 0,
      trunkR: 0,
      trunkTop: 0,
      canopyY: 1,
      canopyR: 2,
      hue: 0,
      grove: false,
    });
    expect(new ThreeGeometry(w).bodyValid(p)).toBe(false);
  });
});
