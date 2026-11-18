/** Optional public-map extensions. Legacy callers omit this contract and retain their exact path. */
import type { Vec3 } from "../sim/types";
import type { Blocker } from "../sim/geometry";
export interface ExtraGeometry {
  extraPhysicalMotion(a: Vec3, b: Vec3): boolean;
  extraValidMotion(a: Vec3, b: Vec3, margin: number): boolean;
  extraFullMotion(a: Vec3, b: Vec3, margin: number): boolean;
  extraClearance(
    p: Vec3,
    margin: number,
  ): { minimum: number; totalDeficit: number };
  escapeDirections(p: Vec3): Vec3[];
}
export interface PublicGeometry extends ExtraGeometry {
  lineOfSight(a: Vec3, b: Vec3): Blocker;
  projectClear(
    p: Vec3,
    margin: number,
    minAgl: number,
  ): { changed: boolean; success: boolean };
  visiblePelvisColumn(
    camera: Vec3 & { yaw: number; pitch: number },
    root: { x: number; z: number },
  ): boolean;
}
