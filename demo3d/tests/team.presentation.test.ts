import { BODY_VERSION } from "../src/team/threeBody";
import { SUBJECT_VERSION } from "../src/team/threeSubject";
import { validateBodyReplaySubject } from "../src/team/replay";
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  overlayFlags,
  displayFrameIndex,
  OVERLAY_DEFAULTS,
  OVERLAY_KEYS,
} from "../src/team/presentation";
import {
  annotationPoint,
  projectAnnotation,
  TeamOverlays,
} from "../src/team/overlays";
import { teamMarkup } from "../src/team/template";
import type { TrackerSnapshot } from "../src/sim/types";
const track: TrackerSnapshot = {
  initialised: false,
  x: 0,
  z: 0,
  vx: 1,
  vz: 0,
  sigma: 1,
  radius: 2.447,
  age: 0,
  hits: 0,
  status: "TRACKING",
};
describe("recorded team analysis presentation", () => {
  it("keeps three-drone annotation wording in a fixed key and two-drone callouts intact", () => {
    const three = teamMarkup({ fleet: 3, duration: 75 });
    const two = teamMarkup({ fleet: 2, duration: 75 });
    expect((three.match(/class="team-annotation-key"/g) ?? []).length).toBe(3);
    expect(three).toContain('role="group" aria-label="Drone A camera marker key"');
    expect(three).toContain('class="team-annotation" id="annotation-A" aria-hidden="true" hidden></div>');
    expect(three).toContain("Own noisy report");
    expect(three).toContain("Predicted position / no fix");
    expect(two).not.toContain("team-annotation-key");
    expect(two).toContain(
      '<div class="team-annotation" id="annotation-A" aria-hidden="true" hidden><span></span></div>',
    );
  });
  it("selects the exact recorded frame at decimal seek boundaries without crossing real sub-ticks", () => {
    expect(displayFrameIndex(42.8, 6001)).toBe(856);
    expect(displayFrameIndex(42.799999, 6001)).toBe(855);
    expect(displayFrameIndex(42.8-1e-7,6001)).toBe(855);
    expect(displayFrameIndex(42.8+1e-7,6001)).toBe(856);
    expect(displayFrameIndex(300, 6001)).toBe(6000);
    for (let i = 0; i <= 6000; i++)
      expect(displayFrameIndex(i * 0.05, 6001)).toBe(i);
  });

  it("rejects malformed body transport even when the caller could recompute a digest", () => {
    const subject = {
      x: 1,
      y: 0,
      z: 2,
      subjectVersion: SUBJECT_VERSION,
      bodyVersion: BODY_VERSION,
      body: {
        root: { x: 1, y: 0, z: 2 },
        heading: 0,
        gait: 0,
        speed: 0,
        posture: { from: "standing", to: "prone", progress: 0.4 },
      },
    };
    expect(() =>
      validateBodyReplaySubject(subject, { heightAt: () => 0 }),
    ).not.toThrow();
    expect(() =>
      validateBodyReplaySubject(subject, { heightAt: () => 100 }),
    ).toThrow("grounding mismatch");
    expect(() =>
      validateBodyReplaySubject(subject, { heightAt: () => NaN }),
    ).toThrow("grounding mismatch");
    for (const change of [
      (s: any) => (s.body.root.x = NaN),
      (s: any) => (s.body.heading = Infinity),
      (s: any) => delete s.body.gait,
      (s: any) => (s.body.speed = -1),
      (s: any) => (s.body.posture.from = "flying"),
      (s: any) => (s.body.posture.progress = 1.01),
      (s: any) => (s.bodyVersion = "old"),
      (s: any) => (s.subjectVersion = "old"),
      (s: any) => (s.body.root.x = 2),
    ]) {
      const bad = structuredClone(subject);
      change(bad);
      expect(() => validateBodyReplaySubject(bad)).toThrow("body contract");
    }
  });

  it("accepts only literal0/1 flags and defaults malformed values independently", () => {
    expect(overlayFlags(new URLSearchParams())).toEqual(OVERLAY_DEFAULTS);
    for (const key of OVERLAY_KEYS)
      for (const value of ["true", "false", "01", "NaN", ""])
        expect(overlayFlags(new URLSearchParams(`${key}=${value}`))[key]).toBe(
          OVERLAY_DEFAULTS[key],
        );
    for (const key of OVERLAY_KEYS) {
      expect(overlayFlags(new URLSearchParams(`${key}=0`))[key]).toBe(false);
      expect(overlayFlags(new URLSearchParams(`${key}=1`))[key]).toBe(true);
    }
  });
  it("shows only current own noisy report or initialized own prediction, never shared truth", () => {
    const forbidden = {
      get subject() {
        throw Error("truth read");
      },
      get teammate() {
        throw Error("peer read");
      },
    };
    expect(
      annotationPoint(
        Object.assign(forbidden, { track, observation: null }),
        () => 2,
      ),
    ).toBeNull();
    expect(
      annotationPoint(
        { track: { ...track, initialised: true }, observation: null },
        () => 2,
      ),
    ).toEqual({ point: { x: 0, y: 3, z: 0 }, prediction: true });
    expect(
      annotationPoint(
        { track, observation: { t: 1, x: 4, z: 5, sigma: 2 } },
        () => 2,
      ),
    ).toEqual({ point: { x: 4, y: 3, z: 5 }, prediction: false });
  });
  it("uses actual own camera projection and suppresses behind-camera/outside-image marks", () => {
    const a = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 260);
    a.position.set(0, 1, 0);
    a.lookAt(0, 1, -10);
    a.updateProjectionMatrix();
    expect(projectAnnotation({ x: 0, y: 1, z: -10 }, a)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(projectAnnotation({ x: 0, y: 1, z: 10 }, a)).toBeNull();
    const b = a.clone();
    b.position.x = 5;
    b.lookAt(5, 1, -10);
    expect(projectAnnotation({ x: 0, y: 1, z: -10 }, b)?.x).toBeLessThan(0.5);
  });
  it("draws only the supplied past epoch and clears future/stale geometry on backward seek", () => {
    const cells = Array.from({ length: 4 }, (_, i) => ({
      x: i * 6,
      z: 0,
      minX: i * 6 - 3,
      maxX: i * 6 + 3,
      minZ: -3,
      maxZ: 3,
      area: 36,
      valid: true,
      samples: [],
    }));
    const view = new TeamOverlays(cells, () => 0);
    const input = {
      t: 5,
      focus: "B" as const,
      shared: false,
      epoch: { t: 4.5, probability: [0.01, 0.02, 0.95, 0.02] },
      drones: [],
      allocations: [],
      flags: { ...OVERLAY_DEFAULTS },
    };
    view.update(input);
    expect(view.record).toEqual({
      epoch: 4.5,
      source: "B",
      selectedCells: [2],
    });
    view.update({ ...input, t: 0, epoch: null });
    expect(view.record.epoch).toBeNull();
    expect(view.record.selectedCells).toEqual([]);
    expect(view.root.children[0].children).toHaveLength(0);
    view.update({ ...input, t: 0 });
    expect(view.record.epoch).toBeNull();
    expect(view.root.children[0].children).toHaveLength(0);
    view.dispose();
  });
  it("keeps every analysis descendant on spectator layer and does not read hidden fields", () => {
    const overlays = new TeamOverlays([], () => 0);
    const drone = {
      id: "A" as const,
      pos: { x: 0, y: 3, z: 0 },
      track: { ...track, initialised: true },
      observation: { t: 0, x: 1, z: 2, sigma: 1 },
      get subject() {
        throw Error("truth read");
      },
    };
    const before = JSON.stringify(drone.track);
    overlays.update({
      t: 0,
      focus: "A",
      shared: true,
      epoch: null,
      drones: [drone],
      allocations: [],
      flags: {
        mass: true,
        predict: true,
        plans: true,
        marks: true,
        annotations: true,
        fill: false,
      },
    });
    let count = 0;
    overlays.root.traverse((o) => {
      expect(o.layers.mask).toBe(2);
      count++;
    });
    expect(count).toBeGreaterThan(5);
    expect(JSON.stringify(drone.track)).toBe(before);
    overlays.dispose();
  });
});
