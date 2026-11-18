/** Team-only motion geometry. Sensor LOS and the frozen single-drone projector are unchanged. */
import { segmentHitsCylinder, segmentHitsSphere } from "../sim/geometry";
import { DRONE } from "../sim/drone";
import { terrainHeight, type World, type Tree } from "../sim/world";
import { isRichWorld } from "../sim/richWorld";
import type { Vec3 } from "../sim/types";
import type { ExtraGeometry } from "./geometryProvider";
export const CLEARANCE = {
  epsilonM: 1e-6,
  overshootM: 0.05,
  terrainDepth: 12,
} as const;
const terrainBounds = new WeakMap<World["heightAt"], number>();
terrainBounds.set(terrainHeight, 0.2);
/** Explicit fixture/custom-terrain certificate: upper bound on horizontal Hessian operator norm. */
export function certifyTerrain(heightAt: World["heightAt"], curvature: number) {
  if (!Number.isFinite(curvature) || curvature < 0)
    throw Error("Invalid terrain curvature certificate");
  terrainBounds.set(heightAt, curvature);
}
function curvature(w: World): number {
  // Original sine terms sum to <.15. Rich adds seven Gaussian mounds (<1.6),
  // and a C1 pond blend: |Hh|+2|grad h||grad s|+|level-h||Hs| < 120.
  // 200 is conservative for the frozen rich-v1 parameter ranges, not arbitrary height functions.
  return isRichWorld(w) ? 200 : (terrainBounds.get(w.heightAt) ?? Infinity);
}
const point = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export function cylinderClearance(t: Tree, p: Vec3, margin: number): number {
  return Math.max(
    Math.hypot(p.x - t.x, p.z - t.z) - t.trunkR - margin,
    t.groundY - margin - p.y,
    p.y - t.groundY - t.trunkTop - margin,
  );
}
export function sphereClearance(t: Tree, p: Vec3, margin: number): number {
  return Math.hypot(p.x - t.x, p.y - t.canopyY, p.z - t.z) - t.canopyR - margin;
}
const nearby = (t: Tree, a: Vec3, b: Vec3, margin: number) => {
  const r = Math.max(t.trunkR, t.canopyR) + margin;
  return (
    t.x >= Math.min(a.x, b.x) - r &&
    t.x <= Math.max(a.x, b.x) + r &&
    t.z >= Math.min(a.z, b.z) - r &&
    t.z <= Math.max(a.z, b.z) + r
  );
};
/** Conservative quadratic lower bound between samples; no terrain convexity assumption. */
function terrainSegment(
  w: World,
  a: Vec3,
  b: Vec3,
  minimum: number,
  depth = 0,
  localBound?: (a: Vec3, b: Vec3) => number,
): boolean {
  const eps = CLEARANCE.epsilonM,
    ca = a.y - w.heightAt(a.x, a.z),
    cb = b.y - w.heightAt(b.x, b.z);
  if (Math.min(ca, cb) < minimum - eps) return false;
  const h2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  if (h2 < 1e-18) return true;
  const bound = localBound ? localBound(a, b) : curvature(w);
  if (!Number.isFinite(bound)) return false;
  const q = 0.5 * bound * h2;
  const t = q > 0 ? Math.max(0, Math.min(1, (q - (cb - ca)) / (2 * q))) : 0;
  const lower = ca + (cb - ca) * t - q * t * (1 - t);
  if (lower >= minimum - eps) return true;
  if (depth >= CLEARANCE.terrainDepth) return false;
  const mid = point(a, b, 0.5);
  return (
    terrainSegment(w, a, mid, minimum, depth + 1, localBound) &&
    terrainSegment(w, mid, b, minimum, depth + 1, localBound)
  );
}
export function physicalMotion(
  w: World,
  a: Vec3,
  b: Vec3,
  extra?: ExtraGeometry,
): boolean {
  if (extra && !extra.extraPhysicalMotion(a, b)) return false;
  const e = CLEARANCE.epsilonM;
  if (
    Math.max(Math.abs(a.x), Math.abs(a.z), Math.abs(b.x), Math.abs(b.z)) >
    w.half - 2 + e
  )
    return false;
  for (const t of w.trees) {
    if (!nearby(t, a, b, 0)) continue;
    if (
      t.trunkR > 0 &&
      t.trunkTop > 0 &&
      segmentHitsCylinder(
        a,
        b,
        t.x,
        t.z,
        Math.max(0, t.trunkR - e),
        t.groundY + e,
        t.groundY + t.trunkTop - e,
      )
    )
      return false;
    if (
      t.canopyR > 0 &&
      segmentHitsSphere(
        a,
        b,
        { x: t.x, y: t.canopyY, z: t.z },
        Math.max(0, t.canopyR - e),
      )
    )
      return false;
  }
  return terrainSegment(w, a, b, 0);
}
/** Full margin for previously-clear primitives; existing deficits may only improve or stay level. */
export function validMotion(
  w: World,
  a: Vec3,
  b: Vec3,
  extra?: ExtraGeometry,
): boolean {
  if (
    !physicalMotion(w, a, b, extra) ||
    (extra && !extra.extraValidMotion(a, b, DRONE.obstacleMargin))
  )
    return false;
  const e = CLEARANCE.epsilonM,
    m = DRONE.obstacleMargin;
  for (const t of w.trees) {
    if (!nearby(t, a, b, m)) continue;
    if (t.trunkR > 0 && t.trunkTop > 0) {
      const initial = cylinderClearance(t, a, m),
        effective = m + Math.min(0, initial);
      if (
        segmentHitsCylinder(
          a,
          b,
          t.x,
          t.z,
          Math.max(0, t.trunkR + effective - e),
          t.groundY - effective + e,
          t.groundY + t.trunkTop + effective - e,
        )
      )
        return false;
    }
    if (t.canopyR > 0) {
      const initial = sphereClearance(t, a, m),
        effective = m + Math.min(0, initial);
      if (
        segmentHitsSphere(
          a,
          b,
          { x: t.x, y: t.canopyY, z: t.z },
          Math.max(0, t.canopyR + effective - e),
        )
      )
        return false;
    }
  }
  // Conditional recovery below desired AGL is allowed only above physical terrain and non-worsening.
  return terrainSegment(
    w,
    a,
    b,
    Math.min(DRONE.minAgl, a.y - w.heightAt(a.x, a.z)),
  );
}
export function clearanceState(
  w: World,
  p: Vec3,
  extra = 0,
  geometry?: ExtraGeometry,
) {
  let minimum = Infinity,
    totalDeficit = 0;
  const margin = DRONE.obstacleMargin + extra;
  for (const t of w.trees) {
    if (!nearby(t, p, p, margin)) continue;
    for (const s of [
      t.trunkR > 0 && t.trunkTop > 0
        ? cylinderClearance(t, p, margin)
        : Infinity,
      t.canopyR > 0 ? sphereClearance(t, p, margin) : Infinity,
    ]) {
      minimum = Math.min(minimum, s);
      if (s < -CLEARANCE.epsilonM) totalDeficit -= s;
    }
  }
  const terrain = p.y - w.heightAt(p.x, p.z) - DRONE.minAgl - extra;
  minimum = Math.min(minimum, terrain);
  if (terrain < -CLEARANCE.epsilonM) totalDeficit -= terrain;
  if (geometry) {
    const c = geometry.extraClearance(p, margin);
    minimum = Math.min(minimum, c.minimum);
    totalDeficit += c.totalDeficit;
  }
  return {
    minimum,
    totalDeficit,
    physicalValid: physicalMotion(w, p, p, geometry),
  };
}

/** Public N3 visibility uses the same certified heightfield chord bound; legacy callers are unchanged. */
export function terrainClearanceCertified(
  w: World,
  a: Vec3,
  b: Vec3,
  minimum: number,
) {
  if (!isRichWorld(w)) return terrainSegment(w, a, b, minimum);
  // Base sine Hessian<.2; seven |A|<=4 Gaussian bumps with scale>=6 give <7*8/36, total<1.76.
  // The pond is constant inside its radius and equals rolling terrain outside radius+2.
  const bound = (p: Vec3, q: Vec3) => {
    for (const pond of w.ponds) {
      const da = Math.hypot(p.x - pond.x, p.z - pond.z),
        db = Math.hypot(q.x - pond.x, q.z - pond.z);
      if (da <= pond.radius && db <= pond.radius) return 0;
      const dx = Math.max(
          Math.min(p.x, q.x) - pond.x,
          0,
          pond.x - Math.max(p.x, q.x),
        ),
        dz = Math.max(
          Math.min(p.z, q.z) - pond.z,
          0,
          pond.z - Math.max(p.z, q.z),
        );
      if (Math.hypot(dx, dz) <= pond.radius + 2) return 200;
    }
    return 2;
  };
  return terrainSegment(w, a, b, minimum, 0, bound);
}
