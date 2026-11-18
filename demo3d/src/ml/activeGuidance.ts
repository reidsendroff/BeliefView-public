/** Active-search policy v2. Public map, own pose, noisy observations and raw ONNX belief ONLY. */
import { DRONE, type DroneState, type SearchGuidance } from "../sim/drone";
import { lineOfSight, projectClear } from "../sim/geometry";
import { CAMERA, cameraBasis, fovTest } from "../sim/sensor";
import type { World } from "../sim/world";
import { inWater } from "../sim/richWorld";
import { findPeaks, meanXZ, type BeliefGrid } from "./belief";
import { GRID_N, cellCentre, type FeatureStep } from "./features";
import { Navigation } from "./navigation";
export interface ActiveOptions {
  novelty: number;
  exploration: number;
  routing: boolean;
}
export const ACTIVE_OPTIONS: ActiveOptions = {
  novelty: 0.55,
  exploration: 0.3,
  routing: true,
};
type XZ = { x: number; z: number };
interface Cell extends XZ {
  p: number;
  utility: number;
  heights: number[];
}
export class ActiveSearchGuidance implements SearchGuidance {
  private belief: BeliefGrid | null = null;
  private gaze: XZ | null = null;
  private t = 0;
  private nextSense = 0;
  private misses = new Map<string, { t: number; seen: number }>();
  private nav: Navigation | null = null;
  stats = {
    learnedChoices: 0,
    fallbacks: 0,
    routedChoices: 0,
    plannerMs: 0,
    sensedCells: 0,
  };
  lastDecision: {
    goal: XZ;
    waypoint: XZ;
    visibleMass: number;
    novelUtility: number;
    routeMeters: number;
    path: XZ[];
  } | null = null;
  constructor(
    private world: World,
    private options: ActiveOptions = ACTIVE_OPTIONS,
    private heights: readonly number[] = [1.3],
  ) {}
  setBelief(b: BeliefGrid | null) {
    this.belief = b;
    if (!b) {
      this.gaze = null;
      this.lastDecision = null;
    }
  }
  gazeTarget() {
    return this.belief ? this.gaze : null;
  }
  /** Actual sensor-footprint evidence. Assigned views never mark coverage. No model posterior mutation. */
  observe(step: FeatureStep) {
    this.t = step.t;
    const d = step.drone;
    if (step.obs) {
      this.misses.clear();
      this.nextSense = step.t + 0.5;
      return;
    }
    if (step.t < this.nextSense || !this.belief) return;
    this.nextSense = step.t + 0.5;
    const b = this.belief;
    for (let i = 0; i < GRID_N; i++)
      for (let j = 0; j < GRID_N; j++) {
        const c = cellCentre(b.center, i, j);
        if (Math.hypot(c.x - d.x, c.z - d.z) > 38) continue;
        let seen = 0;
        for (const h of this.heights) {
          const p = { ...c, y: this.world.heightAt(c.x, c.z) + h };
          const f = fovTest(d, d.camYaw, d.camPitch, p);
          if (f.inFov && f.inRange && lineOfSight(this.world, d, p) === "NONE")
            seen += 1 / this.heights.length;
        }
        if (seen) {
          this.misses.set(this.key(c), { t: step.t, seen });
          this.stats.sensedCells++;
        }
      }
  }
  private key(p: XZ) {
    return Math.round(p.x / 2) + "," + Math.round(p.z / 2);
  }
  private novelty(p: XZ) {
    const hit = this.misses.get(this.key(p));
    return hit
      ? 1 - this.options.novelty * hit.seen * Math.exp(-(this.t - hit.t) / 8)
      : 1;
  }
  chooseViewpoint(world: World, d: DroneState): XZ | null {
    const started = performance.now();
    this.lastDecision = null;
    try {
      const b = this.belief;
      if (!b) {
        this.stats.fallbacks++;
        return null;
      }
      const mix =
        this.options.exploration *
        Math.min(1, Math.max(0, (b.elapsed - 6) / 16));
      const reach = Math.min(58, 6.3 * b.elapsed + 4),
        prior = new Float32Array(b.prob.length);
      let priorSum = 0;
      for (let k = 0; k < prior.length; k++) {
        const p = cellCentre(b.center, Math.floor(k / GRID_N), k % GRID_N),
          r = Math.hypot(p.x - b.center.x, p.z - b.center.z);
        if (r < reach && !inWater(world, p.x, p.z, -2.8)) {
          prior[k] = Math.exp((-r * r) / (2 * Math.max(8, reach * 0.6) ** 2));
          priorSum += prior[k];
        }
      }
      const utility = Float32Array.from(b.prob, (p, k) => {
        const c = cellCentre(b.center, Math.floor(k / GRID_N), k % GRID_N);
        return inWater(world, c.x, c.z, -2.8)
          ? 0
          : ((1 - mix) * p + (mix * prior[k]) / (priorSum || 1)) *
              this.novelty(c);
      });
      const order = Array.from({ length: b.prob.length }, (_, k) => k)
        .sort((a, c) => utility[c] - utility[a] || a - c)
        .slice(0, 180);
      const cells: Cell[] = order.map((k) => {
        const c = cellCentre(b.center, Math.floor(k / GRID_N), k % GRID_N);
        return {
          ...c,
          p: b.prob[k],
          utility: utility[k],
          heights: this.heights.map((h) => world.heightAt(c.x, c.z) + h),
        };
      });
      const ub = { ...b, prob: utility };
      const anchors = [
        ...findPeaks(ub, 3, 2, 0.03).map((p) => ({ x: p.x, z: p.z })),
        meanXZ(b),
      ];
      if (mix > 0)
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2,
            r = Math.min(40, 8 + b.elapsed);
          anchors.push({
            x: b.center.x + Math.sin(a) * r,
            z: b.center.z + Math.cos(a) * r,
          });
        }
      const candidates: XZ[] = [{ x: d.pos.x, z: d.pos.z }];
      if (d.viewpoint) candidates.push({ ...d.viewpoint });
      for (const a of anchors)
        for (const r of [7, 13])
          for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI * 2;
            candidates.push({
              x: a.x + Math.sin(ang) * r,
              z: a.z + Math.cos(ang) * r,
            });
          }
      const ranked: {
        pos: XZ;
        gaze: XZ;
        mass: number;
        utility: number;
        score: number;
      }[] = [];
      for (const c of candidates) {
        if (Math.abs(c.x) > world.half - 2 || Math.abs(c.z) > world.half - 2)
          continue;
        const p = { ...c, y: world.heightAt(c.x, c.z) + DRONE.searchAgl },
          q = { ...p };
        if (
          projectClear(world, q, DRONE.obstacleMargin, DRONE.minAgl) &&
          Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) > 0.01
        )
          continue;
        // Visibility and range are cached per candidate; yaw/pitch apply the full actual sensor frustum.
        const localWorld = {
          ...world,
          trees: world.trees.filter(
            (t) => Math.abs(t.x - p.x) < 45 && Math.abs(t.z - p.z) < 45,
          ),
        };
        const visible = cells.map((cell) =>
          cell.heights.map((y) => {
            const t = { x: cell.x, y, z: cell.z };
            return (
              Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z) <= 38 &&
              lineOfSight(localWorld, p, t) === "NONE"
            );
          }),
        );
        let best: { gaze: XZ; mass: number; utility: number } | null = null;
        for (let k = 0; k < 16; k++) {
          const yaw = (k / 16) * 2 * Math.PI,
            gaze = { x: p.x + Math.sin(yaw) * 12, z: p.z + Math.cos(yaw) * 12 };
          const pitch = Math.max(
            -1.5,
            Math.min(
              0.2,
              Math.atan2(
                world.heightAt(gaze.x, gaze.z) + DRONE.targetHeight - p.y,
                12,
              ),
            ),
          );
          const basis = cameraBasis(yaw, pitch),
            th = Math.tan(CAMERA.hHalf),
            tv = Math.tan(CAMERA.vHalf);
          let mass = 0,
            ut = 0;
          for (let j = 0; j < cells.length; j++) {
            const cell = cells[j];
            let frac = 0;
            for (let h = 0; h < cell.heights.length; h++)
              if (visible[j][h]) {
                const dx = cell.x - p.x,
                  dy = cell.heights[h] - p.y,
                  dz = cell.z - p.z;
                const depth = dx * basis.f.x + dy * basis.f.y + dz * basis.f.z;
                const right = dx * basis.r.x + dy * basis.r.y + dz * basis.r.z,
                  up = dx * basis.u.x + dy * basis.u.y + dz * basis.u.z;
                if (
                  depth > 0.5 &&
                  Math.abs(right / depth) <= th &&
                  Math.abs(up / depth) <= tv
                )
                  frac += 1 / cell.heights.length;
              }
            mass += cell.p * frac;
            ut += cell.utility * frac;
          }
          if (!best || ut > best.utility) best = { gaze, mass, utility: ut };
        }
        if (best && best.utility > 0.003)
          ranked.push({
            pos: c,
            ...best,
            score:
              best.utility - 0.0025 * Math.hypot(c.x - d.pos.x, c.z - d.pos.z),
          });
      }
      ranked.sort((a, c) => c.score - a.score);
      const top = ranked.slice(0, 8);
      if (!top.length) {
        this.stats.fallbacks++;
        this.gaze = null;
        return null;
      }
      let paths: ReturnType<Navigation["paths"]>;
      const low =
        d.pos.y - world.heightAt(d.pos.x, d.pos.z) <=
        DRONE.searchCommitAgl + 0.5;
      if (this.options.routing && low) {
        this.nav ??= new Navigation(world);
        paths = this.nav.paths(
          d.pos,
          top.map((x) => x.pos),
        );
      } else
        paths = top.map((r) => ({
          distance: Math.hypot(r.pos.x - d.pos.x, r.pos.z - d.pos.z),
          waypoint: r.pos,
          path: [{ x: d.pos.x, z: d.pos.z }, r.pos],
        }));
      let winner = -1,
        score = -Infinity;
      for (let k = 0; k < top.length; k++) {
        const path = paths[k];
        if (!path) continue;
        const sc = top[k].utility - 0.0025 * path.distance;
        if (sc > score) {
          score = sc;
          winner = k;
        }
      }
      if (winner < 0) {
        this.stats.fallbacks++;
        this.gaze = null;
        return null;
      }
      const selected = top[winner],
        path = paths[winner]!;
      this.gaze = selected.gaze;
      this.stats.learnedChoices++;
      if (path.path.length > 2) this.stats.routedChoices++;
      this.lastDecision = {
        goal: selected.pos,
        waypoint: path.waypoint,
        visibleMass: selected.mass,
        novelUtility: selected.utility,
        routeMeters: path.distance,
        path: path.path,
      };
      return path.waypoint;
    } finally {
      this.stats.plannerMs += performance.now() - started;
    }
  }
}
