/**
 * EVALUATION-ONLY scenario tagging from recorded subject truth. Never imported by the feature extractor, the guidance or
 * the browser model path (a test enforces that); used for training labels' metadata and held-out reporting.
 */
import type { Frame } from "../sim/types";

export interface LostRun {
  /** index of the last frame with a fix before the loss (or 0), and first frame with a fix after (null = never reacquired in the episode) */
  i0: number;
  i1: number | null;
  t0: number;
  t1: number | null;
  /** seconds unobserved, censored at episode end */
  duration: number;
  reacquired: boolean;
  hid: boolean;
  turned: boolean;
  long: boolean;
}

export const LOST_MIN_S = 1.5; // same threshold at which the tracker declares SEARCHING
export const LONG_OCCLUSION_S = 8;

export function lostRuns(frames: Frame[]): LostRun[] {
  const runs: LostRun[] = [];
  let lastFix = -1;
  let i = 0;
  const dt = frames.length > 1 ? frames[1].t - frames[0].t : 0.05;
  while (i < frames.length) {
    if (frames[i].obs) { lastFix = i; i++; continue; }
    if (lastFix < 0) { i++; continue; } // never seen yet: not a "loss"
    let j = i;
    while (j < frames.length && !frames[j].obs) j++;
    const reacq = j < frames.length;
    const endT = reacq ? frames[j].t : frames[frames.length - 1].t + dt;
    const duration = endT - frames[lastFix].t;
    if (duration >= LOST_MIN_S) {
      let hid = false, turned = false;
      for (let k = lastFix; k < Math.min(j, frames.length); k++) {
        const s = frames[k].subject;
        if (s.action === "HIDE" && s.cover >= 0 && s.crouch > 0.5) hid = true;
        if (s.action === "JINK" || s.action === "FEINT") turned = true;
      }
      runs.push({ i0: lastFix, i1: reacq ? j : null, t0: frames[lastFix].t, t1: reacq ? frames[j].t : null, duration, reacquired: reacq, hid, turned, long: duration >= LONG_OCCLUSION_S });
    }
    i = j;
  }
  return runs;
}

export interface SampleTags { hide: boolean; turn: boolean; long: boolean; reacq: boolean }

/** Tags for a prediction tick at frame i inside a lost run (the run's own scenario properties, plus state at i). */
export function sampleTags(frames: Frame[], i: number, run: LostRun): SampleTags {
  const s = frames[i].subject;
  let turnedSoFar = false;
  for (let k = run.i0; k <= i; k++) if (frames[k].subject.action === "JINK" || frames[k].subject.action === "FEINT") { turnedSoFar = true; break; }
  return {
    hide: s.action === "HIDE" && s.cover >= 0 && s.crouch > 0.5,
    turn: turnedSoFar,
    long: frames[i].t - frames[run.i0].t >= LONG_OCCLUSION_S,
    reacq: run.reacquired,
  };
}

export function runOf(runs: LostRun[], i: number): LostRun | null {
  return runs.find((r) => i > r.i0 && (r.i1 === null || i < r.i1)) ?? null;
}
