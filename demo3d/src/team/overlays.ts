/** Recorded public evidence visualization only. No subject truth or simulation mutation. */
import * as THREE from "three";
import { predictCorridor } from "../sim/tracker";
import type { Observation, TrackerSnapshot, Vec3 } from "../sim/types";
import type { Cell } from "./map";
import type { Allocation } from "./planner";
import type { SensorId } from "./types";
import type { OverlayFlags } from "./presentation";
const COLORS = { A: 0xf0cd7c, B: 0x8bc8f0, C: 0xc5a2ed };
export interface OverlayDrone {
  id: SensorId;
  pos: Readonly<Vec3>;
  track: Readonly<TrackerSnapshot>;
  observation: Readonly<Observation> | null;
}
export interface OverlayInput {
  t: number;
  focus: SensorId;
  shared: boolean;
  epoch: { t: number; probability: readonly number[] } | null;
  drones: readonly OverlayDrone[];
  allocations: readonly Allocation[];
  flags: OverlayFlags;
}
export function annotationPoint(
  drone: Pick<OverlayDrone, "observation" | "track">,
  heightAt: (x: number, z: number) => number,
): { point: Vec3; prediction: boolean } | null {
  const source =
    drone.observation ?? (drone.track.initialised ? drone.track : null);
  if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.z))
    return null;
  return {
    point: { x: source.x, y: heightAt(source.x, source.z) + 1, z: source.z },
    prediction: !drone.observation,
  };
}
export function projectAnnotation(
  point: Vec3,
  camera: THREE.PerspectiveCamera,
): { x: number; y: number } | null {
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(point.x, point.y, point.z).project(camera);
  return [p.x, p.y, p.z].every(Number.isFinite) &&
    p.z >= -1 &&
    p.z <= 1 &&
    Math.abs(p.x) <= 1 &&
    Math.abs(p.y) <= 1
    ? { x: (p.x + 1) / 2, y: (1 - p.y) / 2 }
    : null;
}
export class TeamOverlays {
  readonly root = new THREE.Group();
  readonly record: {
    epoch: number | null;
    source: string;
    selectedCells: number[];
  } = { epoch: null, source: "", selectedCells: [] };
  private mass = new THREE.Group();
  private motion = new THREE.Group();
  private massKey = "";
  private motionKey = "";
  constructor(
    private cells: readonly Cell[],
    private heightAt: (x: number, z: number) => number,
  ) {
    this.root.name = "Recorded team analysis";
    this.root.add(this.mass, this.motion);
    this.layer();
  }
  private layer() {
    this.root.traverse((o) => o.layers.set(1));
  }
  private clear(group: THREE.Group) {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material)
        for (const a of Array.isArray(m.material) ? m.material : [m.material])
          a.dispose();
    });
    group.clear();
  }
  private point(x: number, z: number, offset = 0.2) {
    return new THREE.Vector3(x, this.heightAt(x, z) + offset, z);
  }
  private line(
    points: THREE.Vector3[],
    color: number,
    group: THREE.Group,
    dashed = false,
    segments = false,
  ) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = dashed
      ? new THREE.LineDashedMaterial({
          color,
          dashSize: 0.8,
          gapSize: 0.5,
          transparent: true,
          opacity: 0.85,
        })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
    const line = segments
      ? new THREE.LineSegments(geometry, material)
      : new THREE.Line(geometry, material);
    line.computeLineDistances();
    group.add(line);
  }
  private ring(
    x: number,
    z: number,
    r: number,
    color: number,
    group: THREE.Group,
    dashed = false,
  ) {
    this.line(
      Array.from({ length: 49 }, (_, i) =>
        this.point(
          x + Math.cos((i / 48) * Math.PI * 2) * r,
          z + Math.sin((i / 48) * Math.PI * 2) * r,
        ),
      ),
      color,
      group,
      dashed,
    );
  }
  update(input: OverlayInput) {
    const { flags, epoch, focus, shared } = input;
    const massKey = `${epoch && epoch.t <= input.t ? epoch.t : "none"}/${shared ? "shared" : focus}/${flags.mass}/${flags.fill}`;
    if (massKey !== this.massKey) {
      this.massKey = massKey;
      this.clear(this.mass);
      this.record.epoch = epoch && epoch.t <= input.t ? epoch.t : null;
      this.record.source = shared ? "shared" : focus;
      this.record.selectedCells = [];
      if (epoch && epoch.t <= input.t && (flags.mass || flags.fill)) {
        const ranked = epoch.probability
          .map((p, k) => ({ p, k }))
          .filter(
            (v) => Number.isFinite(v.p) && v.p > 0 && this.cells[v.k]?.valid,
          )
          .sort((a, b) => b.p - a.p || a.k - b.k);
        const selected = new Set<number>();
        let sum = 0;
        for (const v of ranked) {
          selected.add(v.k);
          sum += v.p;
          if (sum >= 0.95) break;
        }
        this.record.selectedCells = [...selected];
        const edges: THREE.Vector3[] = [];
        const fill: number[] = [];
        for (const k of selected) {
          const c = this.cells[k];
          const corners = [
            [c.minX, c.minZ],
            [c.maxX, c.minZ],
            [c.maxX, c.maxZ],
            [c.minX, c.maxZ],
          ].map(([x, z]) => this.point(x, z, 0.12));
          const neighbours = [
            k - 32,
            k % 32 === 31 ? -1 : k + 1,
            k + 32,
            k % 32 === 0 ? -1 : k - 1,
          ];
          for (let side = 0; side < 4; side++)
            if (!selected.has(neighbours[side]))
              edges.push(corners[side], corners[(side + 1) % 4]);
          if (flags.fill)
            for (const n of [0, 1, 2, 0, 2, 3])
              fill.push(...corners[n].toArray());
        }
        const color = shared ? 0x66d9bd : COLORS[focus];
        if (flags.mass && edges.length)
          this.line(edges, color, this.mass, false, true);
        if (fill.length) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(fill, 3));
          this.mass.add(
            new THREE.Mesh(
              g,
              new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.055,
                depthWrite: false,
                side: THREE.DoubleSide,
              }),
            ),
          );
        }
        const peaks: Cell[] = [];
        for (const v of ranked) {
          const c = this.cells[v.k];
          if (peaks.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 12)) {
            peaks.push(c);
            if (flags.mass) this.ring(c.x, c.z, 1.2, color, this.mass);
            if (peaks.length === 3) break;
          }
        }
      }
    }
    const key = `${Math.floor(input.t * 20)}/${focus}/${flags.predict}/${flags.plans}/${flags.marks}`;
    if (key !== this.motionKey) {
      this.motionKey = key;
      this.clear(this.motion);
      for (const d of input.drones) {
        const color = COLORS[d.id];
        if (flags.predict && d.id === focus && d.track.initialised) {
          const path = predictCorridor(d.track, 3, 12);
          this.ring(
            d.track.x,
            d.track.z,
            d.track.radius,
            color,
            this.motion,
            true,
          );
          this.line(
            path.map((p) => this.point(p.x, p.z)),
            color,
            this.motion,
            true,
          );
          const speed = Math.hypot(d.track.vx, d.track.vz),
            nx = speed ? -d.track.vz / speed : 1,
            nz = speed ? d.track.vx / speed : 0;
          for (const sign of [-1, 1])
            this.line(
              path.map((p) =>
                this.point(
                  p.x + sign * nx * p.radius,
                  p.z + sign * nz * p.radius,
                ),
              ),
              color,
              this.motion,
              true,
            );
        }
        if (flags.marks && d.observation) {
          const o = d.observation,
            r = 0.6;
          this.line(
            [
              this.point(o.x - r, o.z - r),
              this.point(o.x + r, o.z - r),
              this.point(o.x + r, o.z + r),
              this.point(o.x - r, o.z + r),
              this.point(o.x - r, o.z - r),
            ],
            color,
            this.motion,
          );
        }
        const a = input.allocations.find((a) => a.id === d.id);
        if (flags.plans && a) {
          this.ring(a.goal.x, a.goal.z, 0.8, color, this.motion);
          this.line(
            [
              new THREE.Vector3(d.pos.x, d.pos.y, d.pos.z),
              this.point(a.waypoint.x, a.waypoint.z, 3),
              this.point(a.goal.x, a.goal.z, 3),
            ],
            color,
            this.motion,
            true,
          );
          this.line(
            [
              this.point(a.goal.x, a.goal.z, 3),
              this.point(a.gaze.x, a.gaze.z, 1),
            ],
            color,
            this.motion,
            true,
          );
        }
      }
    }
    this.layer();
  }
  dispose() {
    this.clear(this.mass);
    this.clear(this.motion);
    this.root.removeFromParent();
  }
}
