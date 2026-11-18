import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRONE } from "../src/sim/drone";
import { lineOfSight, pointInsideTree, segmentHitsCylinder, segmentHitsSphere } from "../src/sim/geometry";
import { fovTest, CAMERA } from "../src/sim/sensor";
import { DEFAULT_CONFIG, buildWorld, canopyBands, simulate } from "../src/sim/simulate";
import { DEFAULT_WAYPOINTS } from "../src/sim/subject";
import { Tracker, TRACKER } from "../src/sim/tracker";
import type { Frame } from "../src/sim/types";

const world = buildWorld(DEFAULT_CONFIG);
const tl = simulate(DEFAULT_CONFIG, world);
const F = tl.frames;
const hz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const tgt = (f: Frame) => ({ x: f.subject.x, y: f.subject.y + DRONE.targetHeight, z: f.subject.z });

describe("determinism", () => {
  it("replays bit-identically for the same seed", () => {
    const again = simulate(DEFAULT_CONFIG, buildWorld(DEFAULT_CONFIG));
    expect(JSON.stringify(again.frames)).toBe(JSON.stringify(F));
    expect(again.events).toEqual(tl.events);
  });
  it("runs 45-90 s at a fixed timestep", () => {
    expect(DEFAULT_CONFIG.duration).toBeGreaterThanOrEqual(45);
    expect(DEFAULT_CONFIG.duration).toBeLessThanOrEqual(90);
    expect(F.length).toBe(Math.round(DEFAULT_CONFIG.duration / DEFAULT_CONFIG.dt) + 1);
    for (let i = 1; i < F.length; i++) expect(F[i].t - F[i - 1].t).toBeCloseTo(DEFAULT_CONFIG.dt, 9);
  });
});

describe("subject", () => {
  it("moves continuously on the ground at running speeds (details in subject.test.ts)", () => {
    let dist = 0;
    for (let i = 1; i < F.length; i++) {
      const step = Math.hypot(F[i].subject.x - F[i - 1].subject.x, F[i].subject.z - F[i - 1].subject.z);
      dist += step;
      expect(step / DEFAULT_CONFIG.dt).toBeLessThan(6.9);
    }
    expect(dist).toBeGreaterThan(100);
    for (const f of F) expect(f.subject.y).toBeCloseTo(world.heightAt(f.subject.x, f.subject.z), 9);
  });
});

describe("geometry primitives", () => {
  it("sphere / cylinder segment tests", () => {
    const a = { x: 0, y: 0, z: 0 }, b = { x: 10, y: 0, z: 0 };
    expect(segmentHitsSphere(a, b, { x: 5, y: 0.5, z: 0 }, 1)).toBe(true);
    expect(segmentHitsSphere(a, b, { x: 5, y: 3, z: 0 }, 1)).toBe(false);
    expect(segmentHitsCylinder(a, b, 5, 0, 0.3, -1, 2)).toBe(true);
    expect(segmentHitsCylinder(a, b, 5, 0, 0.3, 1, 2)).toBe(false); // trunk starts above the ray
    expect(segmentHitsCylinder(a, b, 5, 2, 0.3, -1, 2)).toBe(false);
  });
});

describe("occlusion and reacquisition are geometric", () => {
  it("the subject is initially tracked, then occluded by tree geometry, then reacquired", () => {
    const ev = Object.fromEntries(tl.events.map((e) => [e.key, e]));
    expect(F[0].track.status).toBe("TRACKING");
    expect(ev.LOST_VISUAL).toBeDefined();
    expect(ev.SEARCH_START).toBeDefined();
    expect(ev.FIRST_FIX).toBeDefined();
    expect(ev.LOST_VISUAL.t).toBeGreaterThan(5);
    expect(ev.LOST_VISUAL.t).toBeLessThan(ev.SEARCH_START.t);
    expect(ev.SEARCH_START.t).toBeLessThan(ev.FIRST_FIX.t);
    expect(ev.FIRST_FIX.t - ev.LOST_VISUAL.t).toBeGreaterThan(3);
  });
  it("every frame's visibility matches an independent geometry recomputation", () => {
    for (const f of F) {
      const cam = { x: f.drone.x, y: f.drone.y, z: f.drone.z };
      const fov = fovTest(cam, f.cam.yaw, f.cam.pitch, tgt(f));
      const los = lineOfSight(world, cam, tgt(f));
      const visible = fov.inRange && fov.inFov && los === "NONE";
      expect(f.visibility === "VISIBLE").toBe(visible);
      expect(f.obs !== null).toBe(visible);
    }
  });
  it("occlusion frames are blocked by trees (canopy/trunk), not by status flags", () => {
    const lost = F.filter((f) => f.visibility === "OCCLUDED_CANOPY" || f.visibility === "OCCLUDED_TRUNK");
    expect(lost.length).toBeGreaterThan(60);
    const trunkOrCanopy = tl.world.trees.length > 0;
    expect(trunkOrCanopy).toBe(true);
    for (const f of lost) {
      const cam = { x: f.drone.x, y: f.drone.y, z: f.drone.z };
      expect(["CANOPY", "TRUNK"]).toContain(lineOfSight(world, cam, tgt(f)));
    }
  });
  it("reacquisition happens only with LOS + FOV + range", () => {
    const first = F.find((f) => f.i > 0 && f.obs && f.track.status === "REACQUIRING")!;
    expect(first).toBeDefined();
    const cam = { x: first.drone.x, y: first.drone.y, z: first.drone.z };
    const fov = fovTest(cam, first.cam.yaw, first.cam.pitch, tgt(first));
    expect(lineOfSight(world, cam, tgt(first))).toBe("NONE");
    expect(fov.inFov).toBe(true);
    expect(fov.range).toBeLessThanOrEqual(CAMERA.maxRange);
    // the frame before had no fix
    expect(F[first.i - 1].obs).toBeNull();
  });
  it("status only leaves TRACKING after the configured silence", () => {
    for (const f of F) {
      if (f.obs) expect(f.track.age).toBe(0);
      if (f.track.status === "SEARCHING" && f.track.age > 0) expect(f.track.age).toBeGreaterThan(TRACKER.searchAfter - 1e-9);
    }
  });
});

describe("drone search behaviour", () => {
  const ev = Object.fromEntries(tl.events.map((e) => [e.key, e]));
  it("descends and moves horizontally during search", () => {
    const search = F.filter((f) => f.i >= ev.SEARCH_START.i && f.i <= ev.FIRST_FIX.i);
    const drop = search[0].drone.agl - Math.min(...search.map((f) => f.drone.agl));
    expect(drop).toBeGreaterThan(8);
    let horiz = 0;
    for (let i = 1; i < search.length; i++) horiz += hz(search[i].drone, search[i - 1].drone);
    expect(horiz).toBeGreaterThan(8);
    expect(F[0].drone.agl).toBeGreaterThan(20);
  });
  it("goes below the canopy after losing the subject and later climbs", () => {
    const { bottom } = canopyBands(world);
    expect(ev.UNDER_CANOPY).toBeDefined();
    expect(Math.min(...F.map((f) => f.drone.agl))).toBeLessThan(bottom);
    const maxAfter = Math.max(...F.slice(ev.UNDER_CANOPY.i).map((f) => f.drone.agl));
    const minAfter = Math.min(...F.slice(ev.UNDER_CANOPY.i).map((f) => f.drone.agl));
    expect(maxAfter - minAfter).toBeGreaterThan(4); // it also moves vertically after the low search
  });
  it("keeps terrain and obstacle clearance on every frame", () => {
    for (const f of F) {
      expect(f.drone.agl).toBeGreaterThanOrEqual(DRONE.minAgl - 1e-6);
      expect(f.drone.agl).toBeCloseTo(f.drone.y - world.heightAt(f.drone.x, f.drone.z), 9);
      for (const t of world.trees) {
        if (Math.abs(t.x - f.drone.x) > 12 || Math.abs(t.z - f.drone.z) > 12) continue;
        expect(pointInsideTree(t, f.drone, DRONE.obstacleMargin - 0.05)).toBe(false);
      }
    }
  });
  it("respects speed limits", () => {
    for (const f of F) {
      expect(Math.hypot(f.drone.vx, f.drone.vz)).toBeLessThan(DRONE.maxHSpeed + 1.5);
      expect(Math.abs(f.drone.vy)).toBeLessThan(DRONE.maxVSpeed + 1.5);
    }
  });
});

describe("tracker truth independence", () => {
  it("tracker source imports no world / subject / sensor module", () => {
    const src = readFileSync(new URL("../src/sim/tracker.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./types"]);
  });
  it("replaying only the recorded observations reproduces every tracker state", () => {
    const tr = new Tracker();
    F.forEach((f, i) => {
      if (i > 0) tr.predict(DEFAULT_CONFIG.dt);
      if (f.obs) tr.update(f.obs);
      expect(tr.snapshot()).toEqual(f.track);
    });
  });
  it("while unseen the track is pure extrapolation of the prior state; uncertainty grows", () => {
    const ev = Object.fromEntries(tl.events.map((e) => [e.key, e]));
    let prev = F[ev.LOST_VISUAL.i - 1];
    let n = 0;
    for (let i = ev.LOST_VISUAL.i; i <= ev.FIRST_FIX.i - 1; i++) {
      const f = F[i];
      expect(f.obs).toBeNull();
      expect(f.track.x).toBeCloseTo(prev.track.x + prev.track.vx * DEFAULT_CONFIG.dt, 9);
      expect(f.track.z).toBeCloseTo(prev.track.z + prev.track.vz * DEFAULT_CONFIG.dt, 9);
      expect(f.track.vx).toBe(prev.track.vx);
      expect(f.track.radius).toBeGreaterThan(prev.track.radius);
      prev = f; n++;
    }
    expect(n).toBeGreaterThan(60);
    expect(prev.track.radius).toBeGreaterThan(4 * F[ev.LOST_VISUAL.i - 1].track.radius);
  });
  it("a different subject route/seed cannot change tracker or drone until observations differ", () => {
    const alt = DEFAULT_WAYPOINTS.map((p, i) => (i >= 6 ? ([p[0] + (i - 5) * 3, p[1] - (i - 5) * 2] as [number, number]) : p));
    const b = simulate({ ...DEFAULT_CONFIG, waypoints: alt, subjectSeed: DEFAULT_CONFIG.subjectSeed + 5 }, world);
    let k = 0;
    while (k < F.length && JSON.stringify(F[k].obs) === JSON.stringify(b.frames[k].obs)) {
      expect(b.frames[k].track).toEqual(F[k].track);
      expect(b.frames[k].drone).toEqual(F[k].drone);
      expect(b.frames[k].cam).toEqual(F[k].cam);
      k++;
    }
    // non-vacuous: >= 3 s (60 frames) of shared observations, during which the two subjects' true states already differ
    expect(k).toBeGreaterThanOrEqual(60);
    const firstSubjectDiff = F.findIndex((fr, i) => JSON.stringify(fr.subject) !== JSON.stringify(b.frames[i].subject));
    expect(firstSubjectDiff).toBeGreaterThanOrEqual(0);
    expect(firstSubjectDiff).toBeLessThan(k - 30);
    expect(JSON.stringify(F[F.length - 1].subject)).not.toBe(JSON.stringify(b.frames[F.length - 1].subject));
  });
});

describe("low search precedes reacquisition", () => {
  const ev = Object.fromEntries(tl.events.map((e) => [e.key, e]));
  it("orders events LOST -> SEARCH -> CANOPY -> UNDER_CANOPY -> FIRST_FIX -> RECONFIRMED", () => {
    const order = ["LOST_VISUAL", "SEARCH_START", "CANOPY_LAYER", "UNDER_CANOPY", "FIRST_FIX", "RECONFIRMED"];
    for (const k of order) expect(ev[k], k).toBeDefined();
    for (let i = 1; i < order.length; i++) expect(ev[order[i]].t, `${order[i - 1]} < ${order[i]}`).toBeGreaterThan(ev[order[i - 1]].t);
  });
  it("searches below the canopy for a meaningful time and distance before the first fix", () => {
    const { bottom } = canopyBands(world);
    const low = F.filter((f) => f.i >= ev.UNDER_CANOPY.i && f.i < ev.FIRST_FIX.i);
    expect(ev.FIRST_FIX.t - ev.UNDER_CANOPY.t).toBeGreaterThanOrEqual(1.5);
    let path = 0;
    for (let i = 1; i < low.length; i++) path += hz(low[i].drone, low[i - 1].drone);
    expect(path).toBeGreaterThanOrEqual(5);
    expect(hz(F[ev.FIRST_FIX.i].drone, F[ev.UNDER_CANOPY.i].drone)).toBeGreaterThanOrEqual(4);
    for (const f of low) {
      expect(f.drone.agl).toBeLessThan(bottom + 1e-9); // still low (not climbing out) ...
      expect(f.obs).toBeNull(); // ... and genuinely without a fix
      expect(["OCCLUDED_CANOPY", "OCCLUDED_TRUNK", "OUT_OF_FOV", "OUT_OF_RANGE"]).toContain(f.visibility);
    }
    expect(F[ev.UNDER_CANOPY.i].track.status).toBe("SEARCHING");
    expect(F[ev.FIRST_FIX.i].drone.agl).toBeLessThan(bottom + 4); // fix comes from low altitude, not from above
  });
});

describe("timeline events", () => {
  it("are derived and ordered", () => {
    const ts = tl.events.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(tl.events.map((e) => e.key)).toEqual(expect.arrayContaining(["LOST_VISUAL", "SEARCH_START", "CANOPY_LAYER", "UNDER_CANOPY", "FIRST_FIX", "RECONFIRMED"]));
  });
});
