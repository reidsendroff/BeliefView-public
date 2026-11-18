/**
 * Inference-time feature extractor for the learned search-belief model.
 *
 * TRUST BOUNDARY. The only things this module may consume are
 *   - past/current noisy observations        (FeatureObservation: t, x, z, sigma),
 *   - the drone's own pose                   (FeatureDronePose),
 *   - elapsed time                           (FeatureStep.t),
 *   - the known static map                   (KnownMap: trees + terrain height),
 * No start position of any kind is consumed (not even a coarse one): the extractor cannot be used before the first noisy fix.
 * It never receives subject truth, subject action, chosen cover, the perception cue, or the sensor's
 * visibility verdict, and it imports nothing from subject/tracker/simulate/drone (a test enforces this).
 * `push()` copies whitelisted fields only, so extra properties on a richer object are never read.
 *
 * The same code builds training features (tools/gen_episodes.ts) and inference features (browser + closed-loop
 * evaluation), so there is no second implementation to drift. Outputs are quantised to 1/255 for the spatial
 * grid so the dataset can be stored as uint8 and still be bit-identical at inference.
 */
import { lineOfSight } from "../sim/geometry";
import { CAMERA, fovTest } from "../sim/sensor";
import type { World } from "../sim/world";

export const EXTRACTOR_VERSION = 2; // v2: no start-hint inputs; features exist only after the first noisy fix
export const GRID_N = 32;
export const CELL_M = 4;
export const GRID_SPAN_M = GRID_N * CELL_M;
export const TARGET_HEIGHT = 1.3; // same torso height the sensor model uses for line of sight (a sensor constant, not truth)
export const MAX_SUBJECT_SPEED = 6.3; // public design bound used for the reachability channel

export const CHANNELS = [
  "canopy_cover",
  "trunk_proximity",
  "sensor_visible_now",
  "sensor_visible_memory",
  "extrapolated_position",
  "reachable_radius",
  "drone_position",
  "terrain_height",
] as const;

export const SCALARS = [
  "elapsed_since_fix",
  "time",
  "last_fix_sigma",
  "est_vx",
  "est_vz",
  "est_speed",
  "drone_agl",
  "cam_yaw_sin",
  "cam_yaw_cos",
  "cam_pitch",
  "drone_dx_from_center",
  "drone_dz_from_center",
  "recent_fix_count",
] as const;

/** Normalisation constants, mirrored verbatim into the manifest. */
export const SCALAR_NORM: Record<(typeof SCALARS)[number], { scale: number; min: number; max: number }> = {
  elapsed_since_fix: { scale: 30, min: 0, max: 2 },
  time: { scale: 75, min: 0, max: 2 },
  last_fix_sigma: { scale: 2, min: 0, max: 2 },
  est_vx: { scale: 6, min: -1.5, max: 1.5 },
  est_vz: { scale: 6, min: -1.5, max: 1.5 },
  est_speed: { scale: 6, min: 0, max: 1.5 },
  drone_agl: { scale: 30, min: -1, max: 2 },
  cam_yaw_sin: { scale: 1, min: -1, max: 1 },
  cam_yaw_cos: { scale: 1, min: -1, max: 1 },
  cam_pitch: { scale: 1.5, min: -1.5, max: 1.5 },
  drone_dx_from_center: { scale: GRID_SPAN_M / 2, min: -3, max: 3 },
  drone_dz_from_center: { scale: GRID_SPAN_M / 2, min: -3, max: 3 },
  recent_fix_count: { scale: 20, min: 0, max: 2 },
};

export interface FeatureObservation { t: number; x: number; z: number; sigma: number }
export interface FeatureDronePose { x: number; y: number; z: number; camYaw: number; camPitch: number }
export interface FeatureStep { t: number; obs: FeatureObservation | null; drone: FeatureDronePose }
export type KnownMap = Pick<World, "trees" | "half" | "heightAt">;

export interface FeatureOutput {
  /** [CHANNELS.length, GRID_N, GRID_N] row-major (channel, z-row, x-col); values are q/255. */
  grid: Float32Array;
  /** The exact uint8 codes (grid = codes / 255). */
  codes: Uint8Array;
  scalars: Float32Array;
  /** World xz of the grid centre (the last fix). Cell (row i, col j) centre = centre + ((j+0.5-N/2)*CELL, (i+0.5-N/2)*CELL). */
  center: { x: number; z: number };
  t: number;
  elapsed: number;
  hasFix: boolean;
}

// ---------------------------------------------------------------- static map rasters (known map only)
interface Raster { canopy: Uint8Array; trunk: Uint8Array; half: number; size: number }
const rasterCache = new WeakMap<object, Raster>();

function rasterOf(map: KnownMap): Raster {
  const hit = rasterCache.get(map.trees);
  if (hit) return hit;
  const half = Math.ceil(map.half), size = half * 2;
  const canopy = new Uint8Array(size * size), trunk = new Uint8Array(size * size);
  const stamp = (arr: Uint8Array, cx: number, cz: number, r: number) => {
    const x0 = Math.max(0, Math.floor(cx + half - r)), x1 = Math.min(size - 1, Math.ceil(cx + half + r));
    const z0 = Math.max(0, Math.floor(cz + half - r)), z1 = Math.min(size - 1, Math.ceil(cz + half + r));
    for (let zi = z0; zi <= z1; zi++) for (let xi = x0; xi <= x1; xi++) {
      const dx = xi + 0.5 - half - cx, dz = zi + 0.5 - half - cz;
      if (dx * dx + dz * dz <= r * r) arr[zi * size + xi] = 1;
    }
  };
  for (const t of map.trees) { stamp(canopy, t.x, t.z, t.canopyR); stamp(trunk, t.x, t.z, t.trunkR + 1.2); }
  const r = { canopy, trunk, half, size };
  rasterCache.set(map.trees, r);
  return r;
}

const SUB = [-1.5, -0.5, 0.5, 1.5];
function cellMean(r: Raster, arr: Uint8Array, x: number, z: number): number {
  let s = 0;
  for (const oz of SUB) for (const ox of SUB) {
    const xi = Math.floor(x + ox + r.half), zi = Math.floor(z + oz + r.half);
    if (xi >= 0 && zi >= 0 && xi < r.size && zi < r.size) s += arr[zi * r.size + xi];
  }
  return s / 16;
}

const q8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const clip = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const HOLD_LOST_S = 0.5;

export class FeatureExtractor {
  private lastFix: FeatureObservation | null = null;
  private fixes: FeatureObservation[] = [];
  private pose: FeatureDronePose | null = null;
  private t = 0;
  private cov = new Float32Array(GRID_N * GRID_N);
  private covNextT = 0;
  private covCenter: { x: number; z: number } | null = null;

  /** @param covEvery seconds between visibility-memory updates while a fix is missing */
  constructor(private map: KnownMap, private covEvery = 0.5) {}

  get hasFix(): boolean { return this.lastFix !== null; }
  elapsed(): number { return this.lastFix ? this.t - this.lastFix.t : this.t; }
  /** True only after at least one noisy fix has been received and none for longer than the coast threshold. Never true before the first fix. */
  lost(): boolean { return this.lastFix !== null && this.elapsed() > HOLD_LOST_S; }
  /** Last fix position; only defined once a fix exists. */
  centre(): { x: number; z: number } {
    if (!this.lastFix) throw new Error("FeatureExtractor.centre() called before the first fix");
    return { x: this.lastFix.x, z: this.lastFix.z };
  }

  /** Feed every simulation step in order. Reads ONLY the whitelisted fields below. */
  push(step: FeatureStep): void {
    const t = step.t;
    const o = step.obs;
    const d = step.drone;
    this.t = t;
    this.pose = { x: d.x, y: d.y, z: d.z, camYaw: d.camYaw, camPitch: d.camPitch };
    if (o) {
      const fix = { t: o.t, x: o.x, z: o.z, sigma: o.sigma };
      this.lastFix = fix;
      this.fixes.push(fix);
      if (this.fixes.length > 200) this.fixes.splice(0, this.fixes.length - 200);
      this.cov.fill(0);
      this.covCenter = null;
      this.covNextT = t + this.covEvery;
    } else if (this.lost() && t >= this.covNextT - 1e-9) {
      const c = this.centre();
      if (!this.covCenter) { this.covCenter = c; this.cov.fill(0); }
      const decay = Math.exp(-this.covEvery / 25);
      for (let k = 0; k < this.cov.length; k++) this.cov[k] *= decay;
      this.markVisible(this.cov, c, this.pose, true);
      this.covNextT = t + this.covEvery;
    }
  }

  /** Cells the sensor model says the drone could currently see (FOV + range + map line of sight). */
  private markVisible(into: Float32Array, c: { x: number; z: number }, p: FeatureDronePose, maxMode: boolean): void {
    const pos = { x: p.x, y: p.y, z: p.z };
    const maxR = CAMERA.maxRange + CELL_M;
    for (let i = 0; i < GRID_N; i++) for (let j = 0; j < GRID_N; j++) {
      const x = c.x + (j + 0.5 - GRID_N / 2) * CELL_M, z = c.z + (i + 0.5 - GRID_N / 2) * CELL_M;
      if (Math.hypot(x - p.x, z - p.z) > maxR) continue;
      const target = { x, y: this.map.heightAt(x, z) + TARGET_HEIGHT, z };
      const f = fovTest(pos, p.camYaw, p.camPitch, target);
      if (!f.inRange || !f.inFov) continue;
      if (lineOfSight(this.map as World, pos, target) !== "NONE") continue;
      const k = i * GRID_N + j;
      into[k] = maxMode ? Math.max(into[k], 1) : 1;
    }
  }

  /** Least-squares velocity over the fixes of the last 2 s before the latest fix. */
  private velocity(): { vx: number; vz: number; n: number } {
    const last = this.lastFix;
    if (!last) return { vx: 0, vz: 0, n: 0 };
    const win = this.fixes.filter((f) => last.t - f.t <= 2.0);
    const n = win.length;
    if (n < 2) return { vx: 0, vz: 0, n };
    let mt = 0, mx = 0, mz = 0;
    for (const f of win) { mt += f.t; mx += f.x; mz += f.z; }
    mt /= n; mx /= n; mz /= n;
    let stt = 0, stx = 0, stz = 0;
    for (const f of win) { stt += (f.t - mt) ** 2; stx += (f.t - mt) * (f.x - mx); stz += (f.t - mt) * (f.z - mz); }
    if (stt < 0.05) return { vx: 0, vz: 0, n };
    return { vx: stx / stt, vz: stz / stt, n: win.filter((f) => last.t - f.t <= 5).length };
  }

  /** Build the model input for the latest pushed step. Pure with respect to extractor state. */
  extract(): FeatureOutput {
    if (!this.pose) throw new Error("FeatureExtractor.extract() called before any push()");
    if (!this.lastFix) throw new Error("FeatureExtractor.extract() called before the first noisy fix: the learned model is never invoked without one");
    const p = this.pose, t = this.t;
    const c = this.centre();
    const elapsed = this.elapsed();
    const { vx, vz, n: nFix } = this.velocity();
    const sigma0 = this.lastFix.sigma;
    const ex = c.x + vx * elapsed, ez = c.z + vz * elapsed;
    const spread = (sigma0 + 1.5 * elapsed + 2) / CELL_M;
    const reach = MAX_SUBJECT_SPEED * elapsed + 2;
    const R = rasterOf(this.map);
    const N2 = GRID_N * GRID_N;
    const codes = new Uint8Array(CHANNELS.length * N2);
    const vis = new Float32Array(N2);
    this.markVisible(vis, c, p, false);
    const memSame = this.covCenter !== null && this.covCenter.x === c.x && this.covCenter.z === c.z;
    for (let i = 0; i < GRID_N; i++) for (let j = 0; j < GRID_N; j++) {
      const k = i * GRID_N + j;
      const x = c.x + (j + 0.5 - GRID_N / 2) * CELL_M, z = c.z + (i + 0.5 - GRID_N / 2) * CELL_M;
      codes[0 * N2 + k] = q8(cellMean(R, R.canopy, x, z));
      codes[1 * N2 + k] = q8(cellMean(R, R.trunk, x, z));
      codes[2 * N2 + k] = q8(vis[k]);
      codes[3 * N2 + k] = q8(Math.max(vis[k], memSame ? this.cov[k] : 0));
      const de2 = ((x - ex) ** 2 + (z - ez) ** 2) / (CELL_M * CELL_M);
      codes[4 * N2 + k] = q8(Math.exp(-de2 / (2 * spread * spread)));
      const dc = Math.hypot(x - c.x, z - c.z);
      codes[5 * N2 + k] = q8(1 - dc / reach);
      const dd2 = ((x - p.x) ** 2 + (z - p.z) ** 2) / (CELL_M * CELL_M);
      codes[6 * N2 + k] = q8(Math.exp(-dd2 / 2));
      codes[7 * N2 + k] = q8((this.map.heightAt(x, z) / 8 + 1) / 2);
    }
    const grid = new Float32Array(codes.length);
    for (let k = 0; k < codes.length; k++) grid[k] = Math.fround(codes[k] / 255);
    const agl = p.y - this.map.heightAt(p.x, p.z);
    const raw: Record<(typeof SCALARS)[number], number> = {
      elapsed_since_fix: elapsed, time: t, last_fix_sigma: sigma0,
      est_vx: vx, est_vz: vz, est_speed: Math.hypot(vx, vz), drone_agl: agl,
      cam_yaw_sin: Math.sin(p.camYaw), cam_yaw_cos: Math.cos(p.camYaw), cam_pitch: p.camPitch,
      drone_dx_from_center: p.x - c.x, drone_dz_from_center: p.z - c.z,
      recent_fix_count: nFix,
    };
    const scalars = new Float32Array(SCALARS.length);
    SCALARS.forEach((name, k) => {
      const n = SCALAR_NORM[name];
      scalars[k] = Math.fround(clip(raw[name] / n.scale, n.min, n.max));
    });
    return { grid, codes, scalars, center: c, t, elapsed, hasFix: true };
  }
}

/** Grid cell (row, col) of a world point for a given centre, or null if outside the grid. */
export function cellOf(center: { x: number; z: number }, x: number, z: number): { i: number; j: number } | null {
  const j = Math.floor((x - center.x) / CELL_M + GRID_N / 2), i = Math.floor((z - center.z) / CELL_M + GRID_N / 2);
  if (i < 0 || j < 0 || i >= GRID_N || j >= GRID_N) return null;
  return { i, j };
}
export function cellCentre(center: { x: number; z: number }, i: number, j: number): { x: number; z: number } {
  return { x: center.x + (j + 0.5 - GRID_N / 2) * CELL_M, z: center.z + (i + 0.5 - GRID_N / 2) * CELL_M };
}
