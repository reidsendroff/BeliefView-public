/** N3 simulation-only body-sample detector. Never supplied to guidance. */
import { fovTest } from "../sim/sensor";
import type { DroneState } from "../sim/drone";
import { bodyPose, type BodyInput } from "./threeBody";
import { ThreeGeometry } from "./threeGeometry";
export const SENSOR_VERSION = "n3-nine-body-samples-v1";
export function bodyDetection(
  geometry: ThreeGeometry,
  drone: Pick<DroneState, "pos" | "camYaw" | "camPitch">,
  body: BodyInput,
) {
  const pose = bodyPose(body, geometry.world);
  let visible = 0,
    geometricallyBlocked = 0,
    inFrame = 0;
  for (const sample of pose.samples) {
    const blocked = geometry.lineOfSight(drone.pos, sample.point) !== "NONE";
    if (blocked) geometricallyBlocked++;
    const f = fovTest(drone.pos, drone.camYaw, drone.camPitch, sample.point);
    if (f.inRange && f.inFov) {
      inFrame++;
      if (!blocked) visible++;
    }
  }
  return {
    detected: pose.groundingValid && visible > 0,
    visibleSamples: visible,
    geometricallyBlockedSamples: geometricallyBlocked,
    inFrameSamples: inFrame,
    bodyValid: pose.groundingValid,
  };
}
