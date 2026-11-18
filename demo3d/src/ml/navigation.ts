/** Known-map low-altitude routing. No subject, observations or probability inputs. */
import { DRONE } from "../sim/drone";
import { segmentHitsCylinder, segmentHitsSphere } from "../sim/geometry";
import type { World, Tree } from "../sim/world";
import type { ExtraGeometry } from "../team/geometryProvider";
const CELL = 2,
  MARGIN = DRONE.obstacleMargin + 0.15;
type XZ = { x: number; z: number; y?: number };
class Heap {
  a: { id: number; cost: number }[] = [];
  push(v: { id: number; cost: number }) {
    let i = this.a.length;
    this.a.push(v);
    while (i) {
      const p = (i - 1) >> 1;
      if (this.a[p].cost <= v.cost) break;
      this.a[i] = this.a[p];
      i = p;
    }
    this.a[i] = v;
  }
  pop() {
    const first = this.a[0],
      last = this.a.pop()!;
    if (this.a.length) {
      let i = 0;
      while (i * 2 + 1 < this.a.length) {
        let c = i * 2 + 1;
        if (c + 1 < this.a.length && this.a[c + 1].cost < this.a[c].cost) c++;
        if (this.a[c].cost >= last.cost) break;
        this.a[i] = this.a[c];
        i = c;
      }
      this.a[i] = last;
    }
    return first;
  }
}
export class Navigation {
  private n: number;
  private free: Uint8Array;
  private bins = new Map<string, Tree[]>();
  private edges = new Map<string, boolean>();
  constructor(
    private world: World,
    private geometry?: ExtraGeometry,
  ) {
    this.n = Math.floor((world.half * 2) / CELL) + 1;
    this.free = new Uint8Array(this.n * this.n);
    for (const t of world.trees) {
      const r = Math.max(t.trunkR, t.canopyR) + MARGIN;
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
          const key = x + "," + z;
          const b = this.bins.get(key) ?? [];
          b.push(t);
          this.bins.set(key, b);
        }
    }
    for (let i = 0; i < this.free.length; i++) {
      const p = this.point(i);
      this.free[i] = this.clearSegment(p, p) ? 1 : 0;
    }
  }
  private nearby(a: XZ, b: XZ) {
    const set = new Set<Tree>();
    for (
      let x = Math.floor(Math.min(a.x, b.x) / 8);
      x <= Math.floor(Math.max(a.x, b.x) / 8);
      x++
    )
      for (
        let z = Math.floor(Math.min(a.z, b.z) / 8);
        z <= Math.floor(Math.max(a.z, b.z) / 8);
        z++
      )
        for (const t of this.bins.get(x + "," + z) ?? []) set.add(t);
    return set;
  }
  clearSegment(a: XZ, b: XZ): boolean {
    const p = {
        ...a,
        y: a.y ?? this.world.heightAt(a.x, a.z) + DRONE.searchAgl,
      },
      q = { ...b, y: b.y ?? this.world.heightAt(b.x, b.z) + DRONE.searchAgl };
    if (this.geometry && !this.geometry.extraFullMotion(p, q, MARGIN))
      return false;
    for (const t of this.nearby(a, b)) {
      if (
        (!this.geometry || (t.trunkR > 0 && t.trunkTop > 0)) &&
        segmentHitsCylinder(
          p,
          q,
          t.x,
          t.z,
          t.trunkR + MARGIN,
          t.groundY - MARGIN,
          t.groundY + t.trunkTop + MARGIN,
        )
      )
        return false;
      if (
        (!this.geometry || t.canopyR > 0) &&
        segmentHitsSphere(
          p,
          q,
          { x: t.x, y: t.canopyY, z: t.z },
          t.canopyR + MARGIN,
        )
      )
        return false;
    }
    const len = Math.hypot(b.x - a.x, b.z - a.z),
      steps = Math.ceil(len / 0.75);
    for (let j = 1; j < steps; j++) {
      const u = j / steps,
        x = a.x + (b.x - a.x) * u,
        z = a.z + (b.z - a.z) * u,
        y = p.y + (q.y - p.y) * u;
      if (y < this.world.heightAt(x, z) + DRONE.minAgl) return false;
    }
    return true;
  }
  private point(id: number): XZ {
    return {
      x: (id % this.n) * CELL - this.world.half,
      z: Math.floor(id / this.n) * CELL - this.world.half,
    };
  }
  private nearest(p: XZ): number | null {
    const cx = Math.round((p.x + this.world.half) / CELL),
      cz = Math.round((p.z + this.world.half) / CELL);
    let best: null | number = null,
      bd = Infinity;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx,
          z = cz + dz;
        if (x < 0 || z < 0 || x >= this.n || z >= this.n) continue;
        const id = z * this.n + x,
          pt = this.point(id),
          d = Math.hypot(pt.x - p.x, pt.z - p.z);
        if (this.free[id] && d < bd && this.clearSegment(p, pt)) {
          best = id;
          bd = d;
        }
      }
    return best;
  }
  paths(
    from: XZ,
    goals: XZ[],
  ): ({ distance: number; waypoint: XZ; path: XZ[] } | null)[] {
    const start = this.nearest(from),
      targets = goals.map((g) => this.nearest(g));
    if (start === null) return goals.map(() => null);
    const needed = new Set(targets.filter((t): t is number => t !== null)),
      dist = new Float64Array(this.free.length).fill(Infinity),
      prev = new Int32Array(this.free.length).fill(-1),
      heap = new Heap();
    dist[start] = 0;
    heap.push({ id: start, cost: 0 });
    let visits = 0;
    while (heap.a.length && needed.size && visits++ < 6000) {
      const cur = heap.pop();
      if (cur.cost !== dist[cur.id]) continue;
      needed.delete(cur.id);
      const x = cur.id % this.n,
        z = Math.floor(cur.id / this.n);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = x + dx,
            nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= this.n || nz >= this.n) continue;
          const ni = nz * this.n + nx;
          if (!this.free[ni]) continue;
          const key = Math.min(ni, cur.id) + ":" + Math.max(ni, cur.id);
          let clear = this.edges.get(key);
          if (clear === undefined) {
            clear = this.clearSegment(this.point(cur.id), this.point(ni));
            this.edges.set(key, clear);
          }
          if (!clear) continue;
          const cost = cur.cost + CELL * Math.hypot(dx, dz);
          if (cost < dist[ni]) {
            dist[ni] = cost;
            prev[ni] = cur.id;
            heap.push({ id: ni, cost });
          }
        }
    }
    return goals.map((g, j) => {
      if (this.clearSegment(from, g))
        return {
          distance: Math.hypot(g.x - from.x, g.z - from.z),
          waypoint: g,
          path: [from, g],
        };
      const goal = targets[j];
      if (goal === null || !Number.isFinite(dist[goal])) return null;
      const ids = [goal];
      while (ids[ids.length - 1] !== start) {
        const p = prev[ids[ids.length - 1]];
        if (p < 0) return null;
        ids.push(p);
      }
      const path = [from, ...ids.reverse().map((i) => this.point(i)), g];
      let waypoint = path[1];
      for (let k = 2; k < path.length; k++) {
        if (
          Math.hypot(path[k].x - from.x, path[k].z - from.z) > 7 ||
          !this.clearSegment(from, path[k])
        )
          break;
        waypoint = path[k];
      }
      return {
        distance:
          dist[goal] +
          Math.hypot(
            from.x - this.point(start).x,
            from.z - this.point(start).z,
          ) +
          Math.hypot(g.x - this.point(goal).x, g.z - this.point(goal).z),
        waypoint,
        path,
      };
    });
  }
}
