import type { Tree, World } from "./world";
import type { Vec3, VisibilityReason } from "./types";

export type Blocker = "NONE" | "CANOPY" | "TRUNK" | "TERRAIN";

/** Segment vs sphere: does the open segment a->b pass through the sphere? */
export function segmentHitsSphere(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz || 1e-9;
  let u = ((c.x - a.x) * dx + (c.y - a.y) * dy + (c.z - a.z) * dz) / l2;
  u = Math.min(1, Math.max(0, u));
  const px = a.x + dx * u - c.x, py = a.y + dy * u - c.y, pz = a.z + dz * u - c.z;
  return px * px + py * py + pz * pz < r * r;
}

/** Segment vs finite vertical cylinder (axis through (cx,cz), y in [y0,y1]). */
export function segmentHitsCylinder(a: Vec3, b: Vec3, cx: number, cz: number, r: number, y0: number, y1: number): boolean {
  const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
  const fx = a.x - cx, fz = a.z - cz;
  const A = dx * dx + dz * dz;
  let tMin = 0, tMax = 1;
  if (A < 1e-12) {
    if (fx * fx + fz * fz > r * r) return false;
  } else {
    const B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    tMin = Math.max(tMin, (-B - sq) / (2 * A));
    tMax = Math.min(tMax, (-B + sq) / (2 * A));
    if (tMin > tMax) return false;
  }
  // clip to y-slab
  if (Math.abs(dy) < 1e-12) return a.y >= y0 && a.y <= y1;
  let t0 = (y0 - a.y) / dy, t1 = (y1 - a.y) / dy;
  if (t0 > t1) [t0, t1] = [t1, t0];
  return Math.max(tMin, t0) <= Math.min(tMax, t1);
}

/** First thing that blocks the straight line between two 3D points (analytic trees, sampled terrain). */
export function lineOfSight(world: World, a: Vec3, b: Vec3): Blocker {
  const minX = Math.min(a.x, b.x) - 6, maxX = Math.max(a.x, b.x) + 6;
  const minZ = Math.min(a.z, b.z) - 6, maxZ = Math.max(a.z, b.z) + 6;
  let canopy = false;
  for (const t of world.trees) {
    if (t.x < minX || t.x > maxX || t.z < minZ || t.z > maxZ) continue;
    if (segmentHitsCylinder(a, b, t.x, t.z, t.trunkR, t.groundY, t.groundY + t.trunkTop)) return "TRUNK";
    if (segmentHitsSphere(a, b, { x: t.x, y: t.canopyY, z: t.z }, t.canopyR)) canopy = true;
  }
  if (canopy) return "CANOPY";
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(2, Math.ceil(len / 1.0));
  for (let i = 1; i < n; i++) {
    const u = i / n;
    const x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y = a.y + (b.y - a.y) * u;
    if (y < world.heightAt(x, z) - 0.05) return "TERRAIN";
  }
  return "NONE";
}

export function blockerToReason(b: Blocker): VisibilityReason {
  return b === "NONE" ? "VISIBLE" : b === "CANOPY" ? "OCCLUDED_CANOPY" : b === "TRUNK" ? "OCCLUDED_TRUNK" : "OCCLUDED_TERRAIN";
}

/** Push a point out of tree trunks / canopies (inflated by margin) and above the ground. Returns true if moved. */
export function projectClear(world: World, p: Vec3, margin: number, minAgl: number): boolean {
  let moved = false;
  for (let pass = 0; pass < 8; pass++) {
    for (const t of world.trees) {
      if (Math.abs(p.x - t.x) > 9 || Math.abs(p.z - t.z) > 9) continue;
      const top = t.groundY + t.trunkTop;
      if (p.y < top + margin) {
        const dx = p.x - t.x, dz = p.z - t.z;
        const d = Math.hypot(dx, dz), need = t.trunkR + margin;
        if (d < need) {
          const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
          p.x = t.x + nx * need;
          p.z = t.z + nz * need;
          moved = true;
        }
      }
      const cx = p.x - t.x, cy = p.y - t.canopyY, cz = p.z - t.z;
      const dc = Math.hypot(cx, cy, cz), rc = t.canopyR + margin;
      if (dc < rc) {
        const k = dc > 1e-6 ? rc / dc : 0;
        if (k === 0) p.y = t.canopyY + rc;
        else { p.x = t.x + cx * k; p.y = t.canopyY + cy * k; p.z = t.z + cz * k; }
        moved = true;
      }
    }
    const g = world.heightAt(p.x, p.z) + minAgl;
    if (p.y < g) { p.y = g; moved = true; }
  }
  return moved;
}

export function pointInsideTree(t: Tree, p: Vec3, margin: number): boolean {
  const horiz = Math.hypot(p.x - t.x, p.z - t.z);
  if (horiz < t.trunkR + margin && p.y < t.groundY + t.trunkTop) return true;
  return Math.hypot(p.x - t.x, p.y - t.canopyY, p.z - t.z) < t.canopyR + margin;
}
