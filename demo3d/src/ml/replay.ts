import type { Frame } from "../sim/types";
import { FeatureExtractor, type FeatureOutput, type FeatureStep, type KnownMap } from "./features";

/** The only frame fields the learned path may read. Anything richer (subject truth, visibility, tracker) is not selected here. */
export type NarrowFrame = { t: number; obs: Frame["obs"]; drone: { x: number; y: number; z: number }; cam: { yaw: number; pitch: number } };

export function toFeatureStep(f: NarrowFrame): FeatureStep {
  return {
    t: f.t,
    obs: f.obs ? { t: f.obs.t, x: f.obs.x, z: f.obs.z, sigma: f.obs.sigma } : null,
    drone: { x: f.drone.x, y: f.drone.y, z: f.drone.z, camYaw: f.cam.yaw, camPitch: f.cam.pitch },
  };
}

/** Replays recorded frames through the inference extractor; emits features at every `stride` step while the fix is missing. */
export function replayFeatures(
  frames: readonly NarrowFrame[], map: KnownMap, stride: number,
  onTick: (i: number, f: FeatureOutput) => void,
): void {
  const ex = new FeatureExtractor(map);
  frames.forEach((fr, i) => {
    ex.push(toFeatureStep(fr));
    if (i % stride === 0 && ex.lost()) onTick(i, ex.extract());
  });
}
