/** Spectator-only obstruction test. This module is never imported by inference or sensing. */
import { segmentHitsCylinder, segmentHitsSphere } from "../sim/geometry";
import type { Tree } from "../sim/world";
import type { Vec3 } from "../sim/types";
export function foregroundObstacle(
  tree: Tree,
  camera: Vec3,
  focus: Vec3,
): boolean {
  return (
    segmentHitsCylinder(
      camera,
      focus,
      tree.x,
      tree.z,
      tree.trunkR + 0.55,
      tree.groundY - 0.3,
      tree.groundY + tree.trunkTop + 0.5,
    ) ||
    segmentHitsSphere(
      camera,
      focus,
      { x: tree.x, y: tree.canopyY, z: tree.z },
      tree.canopyR + 0.5,
    )
  );
}
