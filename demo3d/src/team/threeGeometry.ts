/** Public, immutable convex geometry for N3. Rendering and physical tests share these planes/faces. */
import type { Vec3 } from "../sim/types";
import type { World, Tree } from "../sim/world";
import {
  segmentHitsCylinder,
  segmentHitsSphere,
  projectClear as legacyProject,
  type Blocker,
} from "../sim/geometry";
import { fovTest } from "../sim/sensor";
import { terrainClearanceCertified } from "./clearance";
import { BODY, type BodyPose } from "./threeBody";
import { inWater } from "../sim/richWorld";
export const GEOMETRY_EPS = 1e-6;
export interface Plane {
  readonly normal: Vec3;
  readonly offset: number;
}
export interface ConvexSolid {
  readonly id: string;
  readonly objectId: string;
  readonly kind: "boulder" | "log";
  readonly planes: readonly Plane[];
  readonly vertices: readonly Vec3[];
  readonly faces: readonly (readonly number[])[];
  readonly bounds: { min: Vec3; max: Vec3 };
}
export interface N3CoverObject {
  readonly id: string;
  readonly kind: "tree" | "boulder" | "log" | "bush" | "leaf-pile";
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly length: number;
  readonly yaw: number;
  readonly treeIndices: readonly number[];
  readonly solidIds: readonly string[];
}
export interface ThreeWorld extends World {
  n3WorldVersion: string;
  n3Solids: readonly ConvexSolid[];
  n3Covers: readonly N3CoverObject[];
}
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
const mul = (a: Vec3, k: number): Vec3 => ({
  x: a.x * k,
  y: a.y * k,
  z: a.z * k,
});
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const lerp = (a: Vec3, b: Vec3, t: number) => add(a, mul(sub(b, a), t));
export function convexFromPlanes(
  meta: Pick<ConvexSolid, "id" | "objectId" | "kind">,
  input: readonly Plane[],
): ConvexSolid {
  const planes = input.map((p) => {
    const n = norm(p.normal);
    if (!Number.isFinite(n) || n < 1e-9 || !Number.isFinite(p.offset))
      throw Error("Invalid convex plane");
    return { normal: mul(p.normal, 1 / n), offset: p.offset / n };
  });
  const recession: Vec3[] = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++) {
      const d = cross(planes[i].normal, planes[j].normal),
        n = norm(d);
      if (n > 1e-9) {
        recession.push(mul(d, 1 / n), mul(d, -1 / n));
      }
    }
  if (recession.some((d) => planes.every((p) => dot(p.normal, d) <= 1e-9)))
    throw Error("Unbounded convex solid");
  const vertices: Vec3[] = [];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++)
      for (let k = j + 1; k < planes.length; k++) {
        const a = planes[i],
          b = planes[j],
          c = planes[k],
          bc = cross(b.normal, c.normal),
          det = dot(a.normal, bc);
        if (Math.abs(det) < 1e-9) continue;
        const p = mul(
          add(
            add(mul(bc, a.offset), mul(cross(c.normal, a.normal), b.offset)),
            mul(cross(a.normal, b.normal), c.offset),
          ),
          1 / det,
        );
        if (
          planes.every((q) => dot(q.normal, p) <= q.offset + 1e-7) &&
          !vertices.some((q) => norm(sub(p, q)) < 1e-6)
        )
          vertices.push(p);
      }
  if (vertices.length < 4) throw Error("Empty/unbounded convex solid");
  const faces: number[][] = [];
  for (const p of planes) {
    const ids = vertices
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => Math.abs(dot(p.normal, v) - p.offset) < 1e-6)
      .map(({ i }) => i);
    if (ids.length < 3) continue;
    const center = mul(
        ids.reduce((v, i) => add(v, vertices[i]), { x: 0, y: 0, z: 0 }),
        1 / ids.length,
      ),
      axis =
        Math.abs(p.normal.y) < 0.9
          ? { x: 0, y: 1, z: 0 }
          : { x: 1, y: 0, z: 0 },
      u0 = cross(axis, p.normal),
      u = mul(u0, 1 / norm(u0)),
      v = cross(p.normal, u);
    ids.sort(
      (a, b) =>
        Math.atan2(
          dot(sub(vertices[a], center), v),
          dot(sub(vertices[a], center), u),
        ) -
        Math.atan2(
          dot(sub(vertices[b], center), v),
          dot(sub(vertices[b], center), u),
        ),
    );
    faces.push(ids);
  }
  if (faces.length < 4) throw Error("Invalid convex faces");
  const edges = new Map<string, number>();
  let volume = 0;
  for (const face of faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i],
        b = face[(i + 1) % face.length],
        key = Math.min(a, b) + ":" + Math.max(a, b);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    for (let i = 1; i < face.length - 1; i++)
      volume +=
        dot(
          vertices[face[0]],
          cross(vertices[face[i]], vertices[face[i + 1]]),
        ) / 6;
  }
  if (
    [...edges.values()].some((n) => n !== 2) ||
    vertices.length - edges.size + faces.length !== 2 ||
    Math.abs(volume) < 1e-8
  )
    throw Error("Convex mesh is not a closed volume");

  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of vertices)
    for (const key of ["x", "y", "z"] as const) {
      min[key] = Math.min(min[key], p[key]);
      max[key] = Math.max(max[key], p[key]);
    }
  // Redundant physical supports guarantee every plane-inflated envelope stays within AABB+margin.
  for (const key of ["x", "y", "z"] as const)
    for (const sign of [-1, 1]) {
      const normal = { x: 0, y: 0, z: 0 };
      normal[key] = sign;
      const offset = sign > 0 ? max[key] : -min[key];
      if (
        !planes.some(
          (p) =>
            norm(sub(p.normal, normal)) < 1e-9 &&
            Math.abs(p.offset - offset) < 1e-7,
        )
      )
        planes.push({ normal, offset });
    }
  return Object.freeze({
    id: meta.id,
    objectId: meta.objectId,
    kind: meta.kind,
    planes: Object.freeze(
      planes.map((p) =>
        Object.freeze({ normal: Object.freeze(p.normal), offset: p.offset }),
      ),
    ),
    vertices: Object.freeze(vertices.map(Object.freeze)),
    faces: Object.freeze(faces.map((f) => Object.freeze(f))),
    bounds: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
  }) as ConvexSolid;
}
export function convexClearance(s: ConvexSolid, p: Vec3, margin = 0) {
  return Math.max(...s.planes.map((q) => dot(q.normal, p) - q.offset - margin));
}
export function segmentHitsConvex(
  s: ConvexSolid,
  a: Vec3,
  b: Vec3,
  margin = 0,
  epsilon = 0,
): boolean {
  let enter = 0,
    exit = 1;
  const d = sub(b, a);
  for (const p of s.planes) {
    const start = dot(p.normal, a) - p.offset - margin - epsilon,
      delta = dot(p.normal, d);
    if (Math.abs(delta) < 1e-12) {
      if (start > 0) return false;
      continue;
    }
    const t = -start / delta;
    if (delta < 0) enter = Math.max(enter, t);
    else exit = Math.min(exit, t);
    if (enter > exit) return false;
  }
  return enter <= exit && exit >= 0 && enter <= 1;
}
function clipPolygon(input: readonly Vec3[], plane: Plane, slack = 0): Vec3[] {
  const out: Vec3[] = [];
  if (!input.length) return out;
  for (let i = 0; i < input.length; i++) {
    const a = input[i],
      b = input[(i + 1) % input.length],
      da = dot(plane.normal, a) - plane.offset - slack,
      db = dot(plane.normal, b) - plane.offset - slack;
    if (da <= 0) out.push(a);
    if (da <= 0 !== db <= 0) out.push(lerp(a, b, da / (da - db)));
  }
  return out;
}
export function triangleHitsConvex(
  s: ConvexSolid,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  margin = 0,
) {
  let p: Vec3[] = [a, b, c];
  for (const plane of s.planes) {
    p = clipPolygon(
      p,
      { normal: plane.normal, offset: plane.offset + margin },
      GEOMETRY_EPS,
    );
    if (!p.length) return false;
  }
  return true;
}
function segmentDistanceSq(p: Vec3, a: Vec3, b: Vec3) {
  const d = sub(b, a),
    t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1)));
  const v = sub(p, lerp(a, b, t));
  return dot(v, v);
}
/** Closest point to a triangle, including degenerate edges. */
export function triangleDistanceSq(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a),
    ac = sub(c, a),
    n = cross(ab, ac),
    n2 = dot(n, n);
  let best = Math.min(
    segmentDistanceSq(p, a, b),
    segmentDistanceSq(p, b, c),
    segmentDistanceSq(p, c, a),
  );
  if (n2 < 1e-18) return best;
  const q = sub(p, mul(n, dot(sub(p, a), n) / n2)),
    v = sub(q, a),
    aa = dot(ab, ab),
    cc = dot(ac, ac),
    bb = dot(ab, ac),
    det = aa * cc - bb * bb,
    u = (dot(v, ab) * cc - dot(v, ac) * bb) / det,
    w = (dot(v, ac) * aa - dot(v, ab) * bb) / det;
  if (u >= -1e-10 && w >= -1e-10 && u + w <= 1 + 1e-10)
    best = Math.min(best, dot(sub(p, q), sub(p, q)));
  return best;
}
export function triangleHitsCylinder(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  x: number,
  z: number,
  r: number,
  y0: number,
  y1: number,
): boolean {
  let poly = clipPolygon(
    [a, b, c],
    { normal: { x: 0, y: -1, z: 0 }, offset: -y0 },
    GEOMETRY_EPS,
  );
  poly = clipPolygon(
    poly,
    { normal: { x: 0, y: 1, z: 0 }, offset: y1 },
    GEOMETRY_EPS,
  );
  if (!poly.length) return false;
  const center = { x, y: 0, z };
  let distance = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    distance = Math.min(
      distance,
      segmentDistanceSq(
        center,
        { x: p.x, y: 0, z: p.z },
        { x: q.x, y: 0, z: q.z },
      ),
    );
  }
  // Column triangles project to a segment, not a non-degenerate xz polygon.
  return distance <= (r + GEOMETRY_EPS) ** 2;
}
export class ThreeGeometry {
  readonly solids: readonly ConvexSolid[];
  private treeBins = new Map<string, Tree[]>();
  private treeQueries = new Map<string, Tree[]>();

  constructor(readonly world: World) {
    this.solids = (world as Partial<ThreeWorld>).n3Solids ?? [];
    for (const t of world.trees) {
      const r = Math.max(t.trunkR, t.canopyR);
      for (
        let x = Math.floor((t.x - r) / 8);
        x <= Math.floor((t.x + r) / 8);
        x++
      )
        for (
          let z = Math.floor((t.z - r) / 8);
          z <= Math.floor((t.z + r) / 8);
          z++
        ) {
          const key = x + "," + z,
            list = this.treeBins.get(key) ?? [];
          list.push(t);
          this.treeBins.set(key, list);
        }
    }
  }
  private treesNear(a: Vec3, b: Vec3, margin = 0) {
    const x0 = Math.floor((Math.min(a.x, b.x) - margin) / 8),
      x1 = Math.floor((Math.max(a.x, b.x) + margin) / 8),
      z0 = Math.floor((Math.min(a.z, b.z) - margin) / 8),
      z1 = Math.floor((Math.max(a.z, b.z) + margin) / 8),
      key = [x0, x1, z0, z1].join(":");
    const cached = this.treeQueries.get(key);
    if (cached) return cached;
    const set = new Set<Tree>();
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++)
        for (const t of this.treeBins.get(x + "," + z) ?? []) set.add(t);
    const result = [...set];
    if (this.treeQueries.size >= 4096)
      this.treeQueries.delete(this.treeQueries.keys().next().value!);
    this.treeQueries.set(key, result);
    return result;
  }
  private near(s: ConvexSolid, a: Vec3, b: Vec3, m = 0) {
    return (
      s.bounds.max.x + m >= Math.min(a.x, b.x) &&
      s.bounds.min.x - m <= Math.max(a.x, b.x) &&
      s.bounds.max.y + m >= Math.min(a.y, b.y) &&
      s.bounds.min.y - m <= Math.max(a.y, b.y) &&
      s.bounds.max.z + m >= Math.min(a.z, b.z) &&
      s.bounds.min.z - m <= Math.max(a.z, b.z)
    );
  }
  lineOfSight(a: Vec3, b: Vec3): Blocker {
    for (const s of this.solids)
      if (this.near(s, a, b) && segmentHitsConvex(s, a, b)) return "TRUNK";
    for (const t of this.treesNear(a, b)) {
      const r = Math.max(t.trunkR, t.canopyR);
      if (
        t.x < Math.min(a.x, b.x) - r ||
        t.x > Math.max(a.x, b.x) + r ||
        t.z < Math.min(a.z, b.z) - r ||
        t.z > Math.max(a.z, b.z) + r
      )
        continue;
      if (
        t.trunkR > 0 &&
        t.trunkTop > 0 &&
        segmentHitsCylinder(
          a,
          b,
          t.x,
          t.z,
          t.trunkR,
          t.groundY,
          t.groundY + t.trunkTop,
        )
      )
        return "TRUNK";
      if (
        t.canopyR > 0 &&
        segmentHitsSphere(a, b, { x: t.x, y: t.canopyY, z: t.z }, t.canopyR)
      )
        return "CANOPY";
    }
    return terrainClearanceCertified(this.world, a, b, 0) ? "NONE" : "TERRAIN";
  }
  objectBlocks(object: N3CoverObject, a: Vec3, b: Vec3) {
    for (const id of object.solidIds) {
      const s = this.solids.find((s) => s.id === id);
      if (s && segmentHitsConvex(s, a, b)) return true;
    }
    for (const i of object.treeIndices) {
      const t = this.world.trees[i];
      if (!t) continue;
      if (
        t.trunkR > 0 &&
        t.trunkTop > 0 &&
        segmentHitsCylinder(
          a,
          b,
          t.x,
          t.z,
          t.trunkR,
          t.groundY,
          t.groundY + t.trunkTop,
        )
      )
        return true;
      if (
        t.canopyR > 0 &&
        segmentHitsSphere(a, b, { x: t.x, y: t.canopyY, z: t.z }, t.canopyR)
      )
        return true;
    }
    return false;
  }
  extraPhysicalMotion(a: Vec3, b: Vec3) {
    return this.solids.every(
      (s) =>
        !this.near(s, a, b) || !segmentHitsConvex(s, a, b, 0, -GEOMETRY_EPS),
    );
  }
  extraFullMotion(a: Vec3, b: Vec3, margin: number) {
    return this.solids.every(
      (s) =>
        !this.near(s, a, b, margin) ||
        !segmentHitsConvex(s, a, b, margin, -GEOMETRY_EPS),
    );
  }
  extraValidMotion(a: Vec3, b: Vec3, margin: number) {
    return (
      this.extraPhysicalMotion(a, b) &&
      this.solids.every((s) => {
        const effective = margin + Math.min(0, convexClearance(s, a, margin));
        return (
          !this.near(s, a, b, margin) ||
          !segmentHitsConvex(s, a, b, effective, -GEOMETRY_EPS)
        );
      })
    );
  }
  extraClearance(p: Vec3, margin: number) {
    let minimum = Infinity,
      totalDeficit = 0;
    for (const s of this.solids) {
      const d = convexClearance(s, p, margin);
      minimum = Math.min(minimum, d);
      if (d < -GEOMETRY_EPS) totalDeficit -= d;
    }
    return { minimum, totalDeficit };
  }
  escapeDirections(p: Vec3) {
    return this.solids
      .filter((s) => convexClearance(s, p, 2) < 2)
      .flatMap((s) =>
        s.planes.map((q) => ({ x: q.normal.x, y: q.normal.y, z: q.normal.z })),
      );
  }
  projectClear(p: Vec3, margin: number, minAgl: number) {
    let changed = false;
    for (let pass = 0; pass < 12; pass++) {
      changed = legacyProject(this.world, p, margin, minAgl) || changed;
      let extra = false;
      for (const s of this.solids) {
        const d = convexClearance(s, p, margin);
        if (d < 0) {
          let face = s.planes[0],
            best = -Infinity;
          for (const q of s.planes) {
            const v = dot(q.normal, p) - q.offset - margin;
            if (v > best) {
              best = v;
              face = q;
            }
          }
          p.x += face.normal.x * (-d + GEOMETRY_EPS);
          p.y += face.normal.y * (-d + GEOMETRY_EPS);
          p.z += face.normal.z * (-d + GEOMETRY_EPS);
          extra = changed = true;
        }
      }
      if (!extra) break;
    }
    const checked = { x: p.x, y: p.y, z: p.z };
    legacyProject(this.world, checked, margin, minAgl);
    return {
      changed,
      success:
        this.extraClearance(p, margin).totalDeficit <= GEOMETRY_EPS &&
        norm(sub(checked, p)) <= GEOMETRY_EPS,
    };
  }
  visiblePelvisColumn(
    camera: { x: number; y: number; z: number; yaw: number; pitch: number },
    root: { x: number; z: number },
  ) {
    if (Math.hypot(camera.x - root.x, camera.z - root.z) < GEOMETRY_EPS)
      return false;
    const y = this.world.heightAt(root.x, root.z),
      lo = { x: root.x, z: root.z, y: y + BODY.minPelvis },
      hi = { x: root.x, z: root.z, y: y + BODY.maxPelvis };
    for (const p of [lo, hi]) {
      const f = fovTest(camera, camera.yaw, camera.pitch, p);
      if (!f.inFov || !f.inRange) return false;
    }
    for (const t of this.treesNear(camera, lo)) {
      const radius = Math.max(t.trunkR, t.canopyR);
      if (
        t.x < Math.min(camera.x, root.x) - radius ||
        t.x > Math.max(camera.x, root.x) + radius ||
        t.z < Math.min(camera.z, root.z) - radius ||
        t.z > Math.max(camera.z, root.z) + radius
      )
        continue;
      if (
        t.trunkR > 0 &&
        t.trunkTop > 0 &&
        triangleHitsCylinder(
          camera,
          lo,
          hi,
          t.x,
          t.z,
          t.trunkR,
          t.groundY,
          t.groundY + t.trunkTop,
        )
      )
        return false;
      if (
        t.canopyR > 0 &&
        triangleDistanceSq({ x: t.x, y: t.canopyY, z: t.z }, camera, lo, hi) <=
          (t.canopyR + GEOMETRY_EPS) ** 2
      )
        return false;
    }
    for (const s of this.solids)
      if (
        this.near(s, camera, lo, BODY.maxPelvis) &&
        triangleHitsConvex(s, camera, lo, hi)
      )
        return false;
    return terrainClearanceCertified(this.world, camera, lo, 0);
  }
  bodyValid(pose: BodyPose) {
    return this.bodyFailure(pose) === null;
  }
  bodyFailure(pose: BodyPose, obstaclePadding = 0): string | null {
    if (!pose.groundingValid) return "pose:" + pose.invalidReason;
    for (const c of pose.capsules) {
      const radius = c.radius + obstaclePadding;
      for (let k = 0; k <= 4; k++) {
        const p = lerp(c.a, c.b, k / 4);
        if (
          inWater(this.world, p.x, p.z, radius) ||
          Math.max(Math.abs(p.x), Math.abs(p.z)) > this.world.half - 2
        )
          return "water-or-boundary:" + c.id;
      }
      for (const s of this.solids)
        if (
          this.near(s, c.a, c.b, radius) &&
          segmentHitsConvex(s, c.a, c.b, radius, -GEOMETRY_EPS)
        )
          return "convex:" + s.id + ":" + c.id;
      for (const t of this.treesNear(c.a, c.b, radius)) {
        if (
          t.trunkR > 0 &&
          t.trunkTop > 0 &&
          triangleHitsCylinder(
            c.a,
            c.b,
            c.b,
            t.x,
            t.z,
            t.trunkR + radius,
            t.groundY - radius,
            t.groundY + t.trunkTop + radius,
          )
        )
          return "trunk:" + t.x + "," + t.z + ":" + c.id;
        if (
          t.canopyR > 0 &&
          segmentDistanceSq({ x: t.x, y: t.canopyY, z: t.z }, c.a, c.b) <
            (t.canopyR + radius - GEOMETRY_EPS) ** 2
        )
          return "foliage:" + t.x + "," + t.z + ":" + c.id;
      }
    }
    return null;
  }
}
