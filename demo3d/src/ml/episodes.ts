import { Rng } from "../sim/rng";
import { DEFAULT_CONFIG, type SimConfig } from "../sim/simulate";
import type { XZ } from "../sim/route";

/** Seed ranges. Splits are disjoint in BOTH world seed and subject seed. */
export const SPLITS = {
  train: { world0: 1000, subject0: 5000 },
  val: { world0: 20000, subject0: 25000 },
  /** DEVELOPMENT test split: it was looked at while tuning, so it is not a pristine holdout. */
  test: { world0: 40000, subject0: 45000 },
  /** FINAL AUDIT split: fresh seeds, disjoint from train/val/test; evaluated once on the frozen model and never tuned on. */
  audit: { world0: 60000, subject0: 65000 },
} as const;
export type SplitName = keyof typeof SPLITS;

/**
 * One varied episode: world seed (forest layout + sensor noise stream), subject seed (policy stream) and jittered
 * destination waypoints (start area and goal direction vary by +-3 m). The 3D demo's default scenario is NOT one of these.
 */
export function episodeConfig(worldSeed: number, subjectSeed: number): SimConfig {
  const r = new Rng((subjectSeed * 2654435761) ^ worldSeed);
  const waypoints = DEFAULT_CONFIG.waypoints.map(([x, z]): XZ => [x + r.range(-3, 3), z + r.range(-3, 3)]);
  return { ...DEFAULT_CONFIG, seed: worldSeed, subjectSeed, waypoints };
}

export function splitSeeds(split: SplitName, k: number): { worldSeed: number; subjectSeed: number } {
  return { worldSeed: SPLITS[split].world0 + k, subjectSeed: SPLITS[split].subject0 + k };
}
