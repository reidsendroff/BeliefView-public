/** Bounded public-map ground routing. No drone state, sensor verdict or hidden destination inputs beyond a requested goal. */
import { inWater } from "../sim/richWorld";
import { segmentHitsSphere, segmentHitsCylinder } from "../sim/geometry";
import { ThreeGeometry, segmentHitsConvex } from "./threeGeometry";
import type { Vec3 } from "../sim/types";
export interface GroundPoint {
  x: number;
  z: number;
}
export class ThreeGroundNavigation {
  private occupancy = new Map<string, boolean>();
  private edges = new Map<string, boolean>();
  readonly stats = { expansions: 0, failures: 0 };
  constructor(private geometry: ThreeGeometry) {}
  free(x: number, z: number) {
    const w = this.geometry.world;
    if (
      Math.max(Math.abs(x), Math.abs(z)) > w.half - 3 ||
      inWater(w, x, z, 0.4)
    )
      return false;
    const y = w.heightAt(x, z),
      a = { x, y: y + 0.08, z },
      b = { x, y: y + 1.92, z };
    const dx = (w.heightAt(x + 0.2, z) - w.heightAt(x - 0.2, z)) / 0.4,
      dz = (w.heightAt(x, z + 0.2) - w.heightAt(x, z - 0.2)) / 0.4;
    if (Math.hypot(dx, dz) > Math.tan((25 * Math.PI) / 180)) return false;
    for (const t of w.trees) {
      const r = Math.max(t.trunkR, t.canopyR) + 0.6;
      if (Math.abs(t.x - x) > r || Math.abs(t.z - z) > r) continue;
      if (
        t.trunkR > 0 &&
        t.trunkTop > 0 &&
        segmentHitsCylinder(
          a,
          b,
          t.x,
          t.z,
          t.trunkR + 0.6,
          t.groundY,
          t.groundY + t.trunkTop,
        )
      )
        return false;
      if (
        t.canopyR > 0 &&
        segmentHitsSphere(
          a,
          b,
          { x: t.x, y: t.canopyY, z: t.z },
          t.canopyR + 0.6,
        )
      )
        return false;
    }
    for (const s of this.geometry.solids)
      if (segmentHitsConvex(s, a, b, 0.6)) return false;
    return true;
  }
  clear(a: GroundPoint, b: GroundPoint) {
    const distance = Math.hypot(b.x - a.x, b.z - a.z),
      n = Math.max(1, Math.ceil(distance / 0.2));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      if (!this.free(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u))
        return false;
    }
    return true;
  }
  routes(
    from: GroundPoint,
    goals: readonly GroundPoint[],
  ): ({ path: GroundPoint[]; distance: number } | null)[] {
    if (goals.every((g) => this.clear(from, g)))
      return goals.map((g) => ({
        path: [
          { x: from.x, z: from.z },
          { x: g.x, z: g.z },
        ],
        distance: Math.hypot(g.x - from.x, g.z - from.z),
      }));
    const key = (x: number, z: number) => x + "," + z,
      fx = Math.round(from.x),
      fz = Math.round(from.z),
      valid = (x: number, z: number) => {
        const k = key(x, z);
        let v = this.occupancy.get(k);
        if (v === undefined) {
          v = this.free(x, z);
          this.occupancy.set(k, v);
        }
        return v;
      };
    let start: GroundPoint | null = null,
      sd = Infinity;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const p = { x: fx + dx, z: fz + dz },
          d = Math.hypot(p.x - from.x, p.z - from.z);
        if (d < sd && valid(p.x, p.z) && this.clear(from, p)) {
          start = p;
          sd = d;
        }
      }
    if (!start) {
      this.stats.failures++;
      return goals.map(() => null);
    }
    const dist = new Map<string, number>([[key(start.x, start.z), 0]]),
      prev = new Map<string, string>(),
      heap: { x: number; z: number; cost: number }[] = [{ ...start, cost: 0 }];
    let expansions = 0;
    const push = (v: { x: number; z: number; cost: number }) => {
      let i = heap.length;
      heap.push(v);
      while (i) {
        const p = (i - 1) >> 1;
        if (heap[p].cost <= v.cost) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = v;
    };
    const pop = () => {
      const r = heap[0],
        v = heap.pop()!;
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let c = i * 2 + 1;
          if (c + 1 < heap.length && heap[c + 1].cost < heap[c].cost) c++;
          if (heap[c].cost >= v.cost) break;
          heap[i] = heap[c];
          i = c;
        }
        heap[i] = v;
      }
      return r;
    };
    while (heap.length && expansions++ < 4096) {
      const p = pop(),
        pk = key(p.x, p.z);
      if (p.cost !== dist.get(pk)) continue;
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const x = p.x + dx,
            z = p.z + dz;
          if (
            Math.hypot(x - from.x, z - from.z) > 30 ||
            !valid(x, z) ||
            !valid(p.x + dx, p.z) ||
            !valid(p.x, p.z + dz)
          )
            continue;
          const q = { x, z },
            qk = key(x, z),
            cost = p.cost + Math.hypot(dx, dz);
          if (cost >= (dist.get(qk) ?? Infinity)) continue;
          const ek = pk < qk ? pk + ":" + qk : qk + ":" + pk;
          let edge = this.edges.get(ek);
          if (edge === undefined) {
            edge = this.clear(p, q);
            this.edges.set(ek, edge);
          }
          if (!edge) continue;
          dist.set(qk, cost);
          prev.set(qk, pk);
          push({ x, z, cost });
        }
    }
    this.stats.expansions += expansions;
    return goals.map((g) => {
      if (this.clear(from, g))
        return {
          path: [
            { x: from.x, z: from.z },
            { x: g.x, z: g.z },
          ],
          distance: Math.hypot(g.x - from.x, g.z - from.z),
        };
      let end: string | null = null,
        best = Infinity;
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++) {
          const p = { x: Math.round(g.x) + dx, z: Math.round(g.z) + dz },
            k = key(p.x, p.z),
            cost = (dist.get(k) ?? Infinity) + Math.hypot(p.x - g.x, p.z - g.z);
          if (cost < best && this.clear(p, g)) {
            end = k;
            best = cost;
          }
        }
      if (!end) {
        this.stats.failures++;
        return null;
      }
      const path: GroundPoint[] = [{ x: g.x, z: g.z }];
      let k: string | undefined = end;
      while (k) {
        const [x, z] = k.split(",").map(Number);
        path.push({ x, z });
        k = prev.get(k);
      }
      path.push({ x: from.x, z: from.z });
      path.reverse();
      const smooth: GroundPoint[] = [path[0]];
      let i = 0;
      while (i < path.length - 1) {
        let next = i + 1;
        for (let j = i + 2; j < path.length; j++) {
          if (
            Math.hypot(path[j].x - path[i].x, path[j].z - path[i].z) > 7 ||
            !this.clear(path[i], path[j])
          )
            break;
          next = j;
        }
        smooth.push(path[next]);
        i = next;
      }
      return { path: smooth, distance: best + sd };
    });
  }
  segment(a: Vec3, b: Vec3) {
    return this.clear(a, b);
  }
}
