/** Closed-loop search outcomes from recorded frames (evaluation-only: reads recorded truth only to tag scenarios). Pure. */
import type { Frame } from "../sim/types";
import { Rng } from "../sim/rng";
import { lostRuns, type LostRun } from "./scenarios";

export interface RunOutcome {
  lostRuns: number;
  /** seconds from the last fix before the first loss until the next fix; censored at episode end (flag below). */
  firstLossTimeS: number | null;
  firstLossReacquired: boolean | null;
  unobservedS: number;
  meanRunS: number | null;
  reacquiredRuns: number;
  minAgl: number;
  maxHSpeed: number;
  runs: Pick<LostRun, "t0" | "t1" | "duration" | "reacquired" | "hid" | "turned" | "long">[];
}

export function runOutcome(frames: Frame[]): RunOutcome {
  const runs = lostRuns(frames);
  const dt = frames[1].t - frames[0].t;
  let seen = false, unobs = 0, minAgl = Infinity, maxH = 0;
  for (const f of frames) {
    if (f.obs) seen = true; else if (seen) unobs += dt;
    minAgl = Math.min(minAgl, f.drone.agl);
    maxH = Math.max(maxH, Math.hypot(f.drone.vx, f.drone.vz));
  }
  return {
    lostRuns: runs.length,
    firstLossTimeS: runs.length ? runs[0].duration : null,
    firstLossReacquired: runs.length ? runs[0].reacquired : null,
    unobservedS: unobs,
    meanRunS: runs.length ? runs.reduce((a, r) => a + r.duration, 0) / runs.length : null,
    reacquiredRuns: runs.filter((r) => r.reacquired).length,
    minAgl, maxHSpeed: maxH,
    runs: runs.map((r) => ({ t0: r.t0, t1: r.t1, duration: r.duration, reacquired: r.reacquired, hid: r.hid, turned: r.turned, long: r.long })),
  };
}

export interface PairedStat { n: number; meanKalman: number; meanMl: number; meanDiffMlMinusKalman: number; ci95: [number, number]; mlBetter: number; mlWorse: number; ties: number }

/** Paired difference (ML - Kalman; negative = ML faster / less unobserved) with a seeded percentile bootstrap. */
export function paired(kal: number[], ml: number[], tol = 0.05, seed = 12345, B = 4000): PairedStat {
  const n = kal.length;
  const d = kal.map((k, i) => ml[i] - k);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const rng = new Rng(seed);
  const boots: number[] = [];
  for (let b = 0; b < B && n > 0; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rng.next() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const q = (p: number) => (boots.length ? boots[Math.min(boots.length - 1, Math.floor(p * boots.length))] : NaN);
  return {
    n, meanKalman: mean(kal), meanMl: mean(ml), meanDiffMlMinusKalman: mean(d), ci95: [q(0.025), q(0.975)],
    mlBetter: d.filter((x) => x < -tol).length, mlWorse: d.filter((x) => x > tol).length, ties: d.filter((x) => Math.abs(x) <= tol).length,
  };
}

export function percentile(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** RMS distance between the two runs' true subject paths: how far the subject's behaviour diverged (it reacts to the drone). */
export function subjectDivergence(a: Frame[], b: Frame[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i].subject.x - b[i].subject.x) ** 2 + (a[i].subject.z - b[i].subject.z) ** 2;
  return Math.sqrt(s / n);
}
