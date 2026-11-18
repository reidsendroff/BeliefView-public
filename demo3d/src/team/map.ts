/** Public-map geometry cache, independent of hidden subject spawn, route, state and actions. */
import { lineOfSight, projectClear } from "../sim/geometry";
import { CAMERA, cameraBasis, fovTest } from "../sim/sensor";
import { DRONE } from "../sim/drone";
import { inWater } from "../sim/richWorld";
import type { World } from "../sim/world";
import type { PublicGeometry } from "./geometryProvider";
import { GRID, type PublicRegion, type SensorPose } from "./types";
export interface Cell {
  x: number;
  z: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  area: number;
  valid: boolean;
  samples: { x: number; y: number; z: number }[];
}
export interface View {
  x: number;
  z: number;
  y: number;
  yaw: number;
  pitch: number;
  gaze: { x: number; z: number };
  indices: Uint16Array;
  fractions: Float32Array;
  bits: Uint16Array;
}
export const fraction = (mask: number) => {
  let n = 0;
  for (let b = 0; b < 10; b++) n += (mask >> b) & 1;
  return n / 10;
};
export class TeamMap {
  readonly cells: Cell[] = [];
  private cached = new Map<string, View[]>();
  readonly positions: { x: number; z: number }[] = [];
  constructor(
    readonly world: World,
    readonly geometry?: PublicGeometry,
  ) {
    const bound = world.half - 3;
    for (let row = 0; row < GRID.n; row++)
      for (let col = 0; col < GRID.n; col++) {
        const minX = Math.max(-bound, col * GRID.cell - GRID.half),
          maxX = Math.min(bound, (col + 1) * GRID.cell - GRID.half);
        const minZ = Math.max(-bound, row * GRID.cell - GRID.half),
          maxZ = Math.min(bound, (row + 1) * GRID.cell - GRID.half);
        const x = (minX + maxX) / 2,
          z = (minZ + maxZ) / 2,
          area = Math.max(0, maxX - minX) * Math.max(0, maxZ - minZ);
        const wet =
          area > 0 &&
          [
            [minX, minZ],
            [minX, maxZ],
            [maxX, minZ],
            [maxX, maxZ],
          ].every(([a, b]) => inWater(world, a, b));
        const samples = [];
        for (const [dx, dz] of [
          [0, 0],
          [-0.28, -0.28],
          [-0.28, 0.28],
          [0.28, -0.28],
          [0.28, 0.28],
        ])
          for (const height of [0.65, 1.3]) {
            const sx = x + dx * (maxX - minX),
              sz = z + dz * (maxZ - minZ);
            samples.push({ x: sx, z: sz, y: world.heightAt(sx, sz) + height });
          }
        this.cells.push({
          x,
          z,
          minX,
          maxX,
          minZ,
          maxZ,
          area,
          valid: area > 0 && !wet,
          samples,
        });
      }
    // Symmetric fixed lattice. No probability-index top-N truncation, and no hidden route anchors.
    for (
      let x = Math.ceil(-Math.min(80, bound) / 8) * 8;
      x <= Math.min(80, bound);
      x += 8
    )
      for (
        let z = Math.ceil(-Math.min(80, bound) / 8) * 8;
        z <= Math.min(80, bound);
        z += 8
      ) {
        const p = { x, z, y: world.heightAt(x, z) + DRONE.searchAgl },
          q = { ...p };
        if (
          geometry &&
          !geometry.projectClear(q, DRONE.obstacleMargin, DRONE.minAgl).success
        )
          continue;
        if (!geometry)
          projectClear(world, q, DRONE.obstacleMargin, DRONE.minAgl);
        if (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 0.01)
          this.positions.push({ x, z });
      }
  }
  index(x: number, z: number) {
    return (
      Math.max(
        0,
        Math.min(GRID.n - 1, Math.floor((z + GRID.half) / GRID.cell)),
      ) *
        GRID.n +
      Math.max(0, Math.min(GRID.n - 1, Math.floor((x + GRID.half) / GRID.cell)))
    );
  }
  prior(region: PublicRegion): Float64Array {
    const p = Float64Array.from(this.cells, (c) =>
      c.valid
        ? Math.max(
            0,
            Math.min(c.maxX, region.maxX) - Math.max(c.minX, region.minX),
          ) *
          Math.max(
            0,
            Math.min(c.maxZ, region.maxZ) - Math.max(c.minZ, region.minZ),
          )
        : 0,
    );
    this.normalize(p);
    return p;
  }
  normalize(p: Float64Array) {
    let sum = 0;
    for (let k = 0; k < p.length; k++) {
      if (!this.cells[k].valid || !Number.isFinite(p[k]) || p[k] < 0) p[k] = 0;
      sum += p[k];
    }
    if (!sum) {
      for (let k = 0; k < p.length; k++)
        p[k] = this.cells[k].valid ? this.cells[k].area : 0;
      sum = p.reduce((a, b) => a + b, 0);
    }
    if (!sum) throw new Error("Public map has no valid grid support");
    for (let k = 0; k < p.length; k++) p[k] /= sum;
  }
  private local(p: { x: number; z: number }) {
    return {
      seed: this.world.seed,
      half: this.world.half,
      heightAt: this.world.heightAt,
      rocks: [],
      trees: this.world.trees.filter(
        (t) => Math.abs(t.x - p.x) < 45 && Math.abs(t.z - p.z) < 45,
      ),
    };
  }
  footprint(p: SensorPose): Uint16Array {
    if (this.geometry) {
      const out = new Uint16Array(this.cells.length);
      for (let k = 0; k < this.cells.length; k++) {
        const c = this.cells[k];
        if (!c.valid || Math.hypot(c.x - p.x, c.z - p.z) > 43) continue;
        for (let j = 0; j < c.samples.length; j += 2) {
          const q = c.samples[j];
          if (
            !inWater(this.world, q.x, q.z) &&
            this.geometry.visiblePelvisColumn(p, q)
          )
            out[k] |= 3 << j;
        }
      }
      return out;
    }
    const out = new Uint16Array(this.cells.length),
      world = this.local(p);
    for (let k = 0; k < this.cells.length; k++) {
      const c = this.cells[k];
      if (!c.valid || Math.hypot(c.x - p.x, c.z - p.z) > 43) continue;
      for (let j = 0; j < c.samples.length; j++) {
        const q = c.samples[j];
        if (inWater(this.world, q.x, q.z)) continue;
        const f = fovTest(p, p.yaw, p.pitch, q);
        if (f.inRange && f.inFov && lineOfSight(world, p, q) === "NONE")
          out[k] |= 1 << j;
      }
    }
    return out;
  }
  viewsAt(x: number, z: number): View[] {
    const key = x + "," + z,
      found = this.cached.get(key);
    if (found) return found;
    const y = this.world.heightAt(x, z) + DRONE.searchAgl,
      p = { x, y, z },
      world = this.local(p);
    const visible: { k: number; bits: number }[] = [];
    for (let k = 0; k < this.cells.length; k++) {
      const c = this.cells[k];
      if (!c.valid || Math.hypot(c.x - x, c.z - z) > 43) continue;
      let bits = 0;
      for (let j = 0; j < c.samples.length; j++) {
        const q = c.samples[j];
        if (
          !inWater(this.world, q.x, q.z) &&
          Math.hypot(q.x - x, q.y - y, q.z - z) <= CAMERA.maxRange &&
          (this.geometry
            ? this.geometry.lineOfSight(p, q)
            : lineOfSight(world, p, q)) === "NONE"
        )
          bits |= 1 << j;
      }
      if (bits) visible.push({ k, bits });
    }
    const views: View[] = [];
    for (let h = 0; h < 12; h++) {
      const yaw = (h / 12) * Math.PI * 2,
        gaze = { x: x + Math.sin(yaw) * 14, z: z + Math.cos(yaw) * 14 };
      const pitch = Math.max(
          -1.5,
          Math.min(
            0.2,
            Math.atan2(
              this.world.heightAt(gaze.x, gaze.z) + DRONE.targetHeight - y,
              14,
            ),
          ),
        ),
        basis = cameraBasis(yaw, pitch),
        th = Math.tan(CAMERA.hHalf),
        tv = Math.tan(CAMERA.vHalf),
        indices: number[] = [],
        fractions: number[] = [],
        masks: number[] = [];
      for (const { k, bits } of visible) {
        let seen = 0,
          seenMask = 0;
        for (let j = 0; j < 10; j++)
          if (bits & (1 << j)) {
            const q = this.cells[k].samples[j],
              dx = q.x - x,
              dy = q.y - y,
              dz = q.z - z,
              depth = dx * basis.f.x + dy * basis.f.y + dz * basis.f.z,
              right = dx * basis.r.x + dy * basis.r.y + dz * basis.r.z,
              up = dx * basis.u.x + dy * basis.u.y + dz * basis.u.z;
            if (
              depth > 0.5 &&
              Math.abs(right / depth) <= th &&
              Math.abs(up / depth) <= tv
            ) {
              seen++;
              seenMask |= 1 << j;
            }
          }
        if (seen) {
          indices.push(k);
          fractions.push(seen / 10);
          masks.push(seenMask);
        }
      }
      views.push({
        ...p,
        yaw,
        pitch,
        gaze,
        indices: Uint16Array.from(indices),
        fractions: Float32Array.from(fractions),
        bits: Uint16Array.from(masks),
      });
    }
    this.cached.set(key, views);
    return views;
  }
  get cachedPositions() {
    return this.cached.size;
  }
}
