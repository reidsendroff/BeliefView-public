/**
 * Learned search guidance: score candidate low viewpoints against the WEIGHTED set of possible subject locations
 * (the model's probability grid), using the known map's line of sight and the camera's range/FOV. It is not collapsed
 * to a point and fed to the Gaussian planner. Physical limits (speed/accel/clearance/gimbal slew) stay in drone.ts.
 */
import { DRONE, type DroneState, type SearchGuidance } from "../sim/drone";
import { lineOfSight, projectClear } from "../sim/geometry";
import { CAMERA } from "../sim/sensor";
import type { World } from "../sim/world";
import { findPeaks, meanXZ, type BeliefGrid } from "./belief";
import { GRID_N, TARGET_HEIGHT, cellCentre } from "./features";

const MAX_CELLS = 140;
const MASS_COVER = 0.9;
const YAW_BINS = 8;
const TRAVEL_COST = 0.003; // probability-mass units per metre of travel
const HYSTERESIS = 0.04;
const MIN_VISIBLE_MASS = 0.02;

function wrap(a: number): number {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface ViewpointScore { x: number; z: number; mass: number; yaw: number; score: number }

export class LearnedSearchGuidance implements SearchGuidance {
  private belief: BeliefGrid | null = null;
  private gaze: { x: number; z: number } | null = null;
  /** Diagnostics for tests/HUD: how many viewpoints were chosen by the learned scorer vs fell back to Kalman. */
  stats = { learnedChoices: 0, fallbacks: 0 };

  setBelief(b: BeliefGrid | null): void { this.belief = b; if (!b) this.gaze = null; }

  gazeTarget(): { x: number; z: number } | null { return this.belief ? this.gaze : null; }

  chooseViewpoint(world: World, d: DroneState): { x: number; z: number } | null {
    const r = this.score(world, d);
    if (!r) { this.stats.fallbacks++; this.gaze = null; return null; }
    this.stats.learnedChoices++;
    return { x: r.x, z: r.z };
  }

  /** Exposed for tests: best viewpoint by expected visible probability mass. */
  score(world: World, d: DroneState): ViewpointScore | null {
    const b = this.belief;
    if (!b) return null;
    const order = Array.from({ length: b.prob.length }, (_, k) => k).sort((a, c) => b.prob[c] - b.prob[a] || a - c);
    const cells: { x: number; z: number; y: number; p: number }[] = [];
    let acc = 0;
    for (const k of order) {
      if (acc >= MASS_COVER || cells.length >= MAX_CELLS) break;
      const c = cellCentre(b.center, Math.floor(k / GRID_N), k % GRID_N);
      cells.push({ x: c.x, z: c.z, y: world.heightAt(c.x, c.z) + TARGET_HEIGHT, p: b.prob[k] });
      acc += b.prob[k];
    }
    const anchors = [...findPeaks(b, 3, 2, 0.05).map((p) => ({ x: p.x, z: p.z })), meanXZ(b)];
    const cand: { x: number; z: number }[] = [];
    if (d.viewpoint) cand.push({ ...d.viewpoint });
    for (const a of anchors) for (const radius of [8, 14]) for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * 2 * Math.PI;
      cand.push({ x: a.x + Math.cos(ang) * radius, z: a.z + Math.sin(ang) * radius });
    }
    let best: ViewpointScore | null = null;
    let bestGaze: { x: number; z: number } | null = null;
    const half = CAMERA.hHalf;
    for (const c of cand) {
      const p = { x: c.x, y: world.heightAt(c.x, c.z) + DRONE.searchAgl, z: c.z };
      const q = { ...p };
      if (projectClear(world, q, DRONE.obstacleMargin, DRONE.minAgl) && Math.hypot(q.x - p.x, q.z - p.z, q.y - p.y) > 0.01) continue;
      const seen: { bearing: number; p: number; x: number; z: number }[] = [];
      for (const cell of cells) {
        const tp = { x: cell.x, y: cell.y, z: cell.z };
        if (Math.hypot(tp.x - p.x, tp.y - p.y, tp.z - p.z) > CAMERA.maxRange) continue;
        if (lineOfSight(world, p, tp) !== "NONE") continue;
        seen.push({ bearing: Math.atan2(cell.x - p.x, cell.z - p.z), p: cell.p, x: cell.x, z: cell.z });
      }
      let binBest = -1, binMass = 0;
      for (let k = 0; k < YAW_BINS; k++) {
        const yaw = (k / YAW_BINS) * 2 * Math.PI - Math.PI;
        let m = 0;
        for (const s of seen) if (Math.abs(wrap(s.bearing - yaw)) <= half) m += s.p;
        if (m > binMass + 1e-12) { binMass = m; binBest = k; }
      }
      if (binBest < 0) continue;
      const yaw = (binBest / YAW_BINS) * 2 * Math.PI - Math.PI;
      let score = binMass - TRAVEL_COST * Math.hypot(c.x - d.pos.x, c.z - d.pos.z);
      if (d.viewpoint && Math.hypot(d.viewpoint.x - c.x, d.viewpoint.z - c.z) < 1) score += HYSTERESIS;
      if (!best || score > best.score) {
        best = { x: c.x, z: c.z, mass: binMass, yaw, score };
        let gx = 0, gz = 0, gm = 0;
        for (const s of seen) if (Math.abs(wrap(s.bearing - yaw)) <= half) { gx += s.p * s.x; gz += s.p * s.z; gm += s.p; }
        bestGaze = gm > 0 ? { x: gx / gm, z: gz / gm } : null;
      }
    }
    if (!best || best.mass < MIN_VISIBLE_MASS) return null;
    this.gaze = bestGaze;
    return best;
  }
}
