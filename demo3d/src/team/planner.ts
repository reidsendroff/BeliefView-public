/** Full-grid expected coverage and two-aircraft allocation. Only public belief/map/own-state inputs. */
import type { DroneState } from "../sim/drone";
import { DRONE } from "../sim/drone";
import { Navigation } from "../ml/navigation";
import { TeamBelief } from "./belief";
import { TeamMap, fraction, type View } from "./map";
import type { SensorId, TeamArm } from "./types";
export interface Aircraft {
  id: SensorId;
  state: DroneState;
  /** Own accepted-sighting status, never a simulator occlusion verdict. */
  searching?: boolean;
}
export interface Allocation {
  id: SensorId;
  goal: { x: number; z: number };
  waypoint: { x: number; z: number };
  gaze: { x: number; z: number };
  mass: number;
  routeMeters: number;
  overlap: number | null;
  score: number;
  reason: string;
}
export interface Ranked {
  view: View;
  mass: number;
  distance: number;
  score: number;
  waypoint: { x: number; z: number };
}
export class TeamPlanner {
  private nav: Navigation | null = null;
  stats = {
    plans: 0,
    scoredViews: 0,
    routeFailures: 0,
    fallbacks: 0,
    jointFallbacks: 0,
    wallMs: 0,
  };
  constructor(private map: TeamMap) {}
  /** Public known-map routing, shared by ordinary ranking and explicit teammate assistance. */
  routes(
    origin: { x: number; y: number; z: number },
    positions: { x: number; z: number }[],
  ) {
    const low =
      origin.y - this.map.world.heightAt(origin.x, origin.z) <=
      DRONE.searchCommitAgl + 0.5;
    return low
      ? (this.nav ??= new Navigation(this.map.world)).paths(origin, positions)
      : positions.map((v) => ({
          distance: Math.hypot(v.x - origin.x, v.z - origin.z),
          waypoint: v,
          path: [origin, v],
        }));
  }
  private rank(a: Aircraft, b: TeamBelief, sector: boolean, limit = 24, accept?: (p: {x:number;z:number}) => boolean): Ranked[] {
    const p = b.probability,
      origin = a.state.pos,
      ranked: Ranked[] = [];
    if (a.searching === false) {
      const pose = { ...origin, yaw: a.state.camYaw, pitch: a.state.camPitch },
        mask = this.map.footprint(pose),
        indices: number[] = [],
        fractions: number[] = [],
        bits: number[] = [];
      let mass = 0;
      for (let k = 0; k < mask.length; k++)
        if (mask[k]) {
          indices.push(k);
          fractions.push(fraction(mask[k]));
          bits.push(mask[k]);
          mass += p[k] * fraction(mask[k]);
        }
      const view: View = {
        ...origin,
        yaw: pose.yaw,
        pitch: pose.pitch,
        gaze: {
          x: origin.x + Math.sin(pose.yaw) * 14,
          z: origin.z + Math.cos(pose.yaw) * 14,
        },
        indices: Uint16Array.from(indices),
        fractions: Float32Array.from(fractions),
        bits: Uint16Array.from(bits),
      };
      return [{ view, mass, distance: 0, score: mass, waypoint: origin }];
    }
    for (const pos of this.map.positions) {
      const distance = Math.hypot(pos.x - origin.x, pos.z - origin.z);
      if (distance > 55 || (accept && !accept(pos))) continue;
      if (sector && (a.id === "A" ? pos.x >= 0 : pos.x <= 0)) continue;
      let bound = 0;
      for (let k = 0; k < p.length; k++) {
        const c = this.map.cells[k];
        if ((c.x - pos.x) ** 2 + (c.z - pos.z) ** 2 <= 43 ** 2) bound += p[k];
      }
      if (bound < 0.005) continue;
      for (const view of this.map.viewsAt(pos.x, pos.z)) {
        let mass = 0;
        for (let j = 0; j < view.indices.length; j++)
          mass += p[view.indices[j]] * view.fractions[j];
        this.stats.scoredViews++;
        if (mass < 1e-5) continue;
        ranked.push({
          view,
          mass,
          distance,
          score: mass / (1 + distance / 30),
          waypoint: pos,
        });
      }
    }
    const order = (a: Ranked, b: Ranked) =>
      Math.round((b.score - a.score) * 1e12) ||
      a.distance - b.distance ||
      a.view.x - b.view.x ||
      a.view.z - b.view.z ||
      a.view.yaw - b.view.yaw;
    ranked.sort(order);
    // Keep distinct positions in route shortlist; alternative headings at a position remain available after routing.
    const positions: { x: number; z: number }[] = [];
    for (const r of ranked) {
      if (!positions.some((p) => p.x === r.view.x && p.z === r.view.z))
        positions.push({ x: r.view.x, z: r.view.z });
      if (positions.length >= 14) break;
    }
    const paths = this.routes(origin, positions);
    const routed: Ranked[] = [];
    for (const r of ranked) {
      const i = positions.findIndex(
        (v) => v.x === r.view.x && v.z === r.view.z,
      );
      if (i < 0) continue;
      const path = paths[i];
      if (!path) {
        this.stats.routeFailures++;
        continue;
      }
      routed.push({
        ...r,
        distance: path.distance,
        score: r.mass / (1 + path.distance / 30),
        waypoint: path.waypoint,
      });
    }
    routed.sort(order);
    return routed.slice(0, limit);
  }
  /** Additive N3 interface. Project only the public fields actually needed by ranking. */
  candidates(a: Aircraft, belief: TeamBelief, accept?: (p: {x:number;z:number}) => boolean): Ranked[] {
    const safe: Aircraft = { id:a.id, searching:a.searching, state:{
      pos:{x:a.state.pos.x,y:a.state.pos.y,z:a.state.pos.z},
      camYaw:a.state.camYaw,camPitch:a.state.camPitch,
    } as DroneState };
    return this.rank(safe, belief, false, 168, accept);
  }
  plan(
    aircraft: readonly Aircraft[],
    beliefs: ReadonlyMap<SensorId, TeamBelief>,
    arm: TeamArm,
  ): Allocation[] {
    const started = performance.now();
    this.stats.plans++;
    try {
      const sorted = [...aircraft].sort((a, b) => a.id.localeCompare(b.id));
      const ranks = sorted.map((a) =>
        this.rank(a, beliefs.get(a.id)!, arm === "sector"),
      );
      let selected = ranks.map((r) => r[0] ?? null),
        overlap = 0,
        jointSelected = false;
      if (
        arm === "coordinated" &&
        sorted.length === 2 &&
        ranks.every((r) => r.length)
      ) {
        const p = beliefs.get(sorted[0].id)!.probability;
        let best = -Infinity;
        for (const a of ranks[0])
          for (const b of ranks[1]) {
            if (Math.hypot(a.view.x - b.view.x, a.view.z - b.view.z) < 8)
              continue;
            let common = 0,
              i = 0,
              j = 0;
            while (i < a.view.indices.length && j < b.view.indices.length) {
              const x = a.view.indices[i],
                z = b.view.indices[j];
              if (x === z) {
                common += p[x] * fraction(a.view.bits[i] & b.view.bits[j]);
                i++;
                j++;
              } else if (x < z) i++;
              else j++;
            }
            const score =
              a.score +
              b.score -
              common *
                Math.min(1 / (1 + a.distance / 30), 1 / (1 + b.distance / 30));
            if (score > best + 1e-12) {
              best = score;
              jointSelected = true;
              selected = [a, b];
              overlap = common;
            }
          }
      }
      if (arm === "coordinated" && !jointSelected) this.stats.jointFallbacks++;
      return selected.flatMap((r, i) => {
        if (!r) {
          this.stats.fallbacks++;
          return [];
        }
        return [
          {
            id: sorted[i].id,
            goal: { x: r.view.x, z: r.view.z },
            waypoint: r.waypoint,
            gaze: r.view.gaze,
            mass: r.mass,
            routeMeters: r.distance,
            overlap: arm === "coordinated" && !jointSelected ? null : overlap,
            score: r.score,
            reason:
              arm === "coordinated"
                ? jointSelected
                  ? "Marginal team-visible belief mass, discounted by route length"
                  : "Independent allocation fallback: no feasible joint pair"
                : arm === "sector"
                  ? "Independent belief within a fixed public half-region"
                  : "Own expected visible belief mass, discounted by route length",
          },
        ];
      });
    } finally {
      this.stats.wallMs += performance.now() - started;
    }
  }
}
