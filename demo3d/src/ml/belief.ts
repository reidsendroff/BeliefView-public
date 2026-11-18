/** Probability grid produced by the learned model + helpers (peaks, calibrated 95% region, entropy). Pure, no DOM. */
import { CELL_M, GRID_N, cellCentre, type FeatureOutput } from "./features";

export interface BeliefGrid {
  /** Frame index and time the prediction was made for (fixed simulation steps; never wall-clock). */
  i: number;
  t: number;
  center: { x: number; z: number };
  /** GRID_N*GRID_N probabilities (sum 1), row-major (z-row, x-col). */
  prob: Float32Array;
  elapsed: number;
}

export interface Peak { x: number; z: number; mass: number; cell: number }

export function makeBelief(i: number, f: FeatureOutput, prob: Float32Array): BeliefGrid {
  return { i, t: f.t, center: { ...f.center }, prob: Float32Array.from(prob), elapsed: f.elapsed };
}

/** Greedy non-maximum suppression: peaks sorted by local mass (cells within `radius` of the maximum). */
export function findPeaks(b: BeliefGrid, k = 3, radius = 2, minMass = 0.03): Peak[] {
  const taken = new Uint8Array(b.prob.length);
  const out: Peak[] = [];
  for (let n = 0; n < k; n++) {
    let best = -1, bv = -1;
    for (let c = 0; c < b.prob.length; c++) if (!taken[c] && b.prob[c] > bv) { bv = b.prob[c]; best = c; }
    if (best < 0) break;
    const bi = Math.floor(best / GRID_N), bj = best % GRID_N;
    let mass = 0, mx = 0, mz = 0;
    for (let i = Math.max(0, bi - radius); i <= Math.min(GRID_N - 1, bi + radius); i++) {
      for (let j = Math.max(0, bj - radius); j <= Math.min(GRID_N - 1, bj + radius); j++) {
        const c = i * GRID_N + j;
        if (taken[c]) continue;
        const p = b.prob[c], cc = cellCentre(b.center, i, j);
        mass += p; mx += p * cc.x; mz += p * cc.z; taken[c] = 1;
      }
    }
    if (mass < minMass && out.length > 0) break;
    const m = mass || 1e-9;
    out.push({ x: mx / m, z: mz / m, mass, cell: best });
  }
  return out;
}

/** Smallest set of cells (highest probability first) whose mass reaches `level`. Deterministic tie-break on index. */
export function hpdRegion(b: BeliefGrid, level: number): { mask: Uint8Array; cells: number; mass: number } {
  const idx = Array.from({ length: b.prob.length }, (_, k) => k).sort((a, c) => b.prob[c] - b.prob[a] || a - c);
  const mask = new Uint8Array(b.prob.length);
  let acc = 0, n = 0;
  for (const k of idx) {
    if (acc >= level) break;
    mask[k] = 1; acc += b.prob[k]; n++;
  }
  return { mask, cells: n, mass: acc };
}

export function entropyBits(b: BeliefGrid): number {
  let h = 0;
  for (const p of b.prob) if (p > 1e-12) h -= p * Math.log2(p);
  return h;
}

export function meanXZ(b: BeliefGrid): { x: number; z: number } {
  let mx = 0, mz = 0;
  for (let i = 0; i < GRID_N; i++) for (let j = 0; j < GRID_N; j++) {
    const p = b.prob[i * GRID_N + j], c = cellCentre(b.center, i, j);
    mx += p * c.x; mz += p * c.z;
  }
  return { x: mx, z: mz };
}

export const regionAreaM2 = (cells: number): number => cells * CELL_M * CELL_M;
