/** Public-pose local avoidance heuristic. No belief, subject, hidden goal or visibility inputs. */
import { DRONE, type DroneState } from "../sim/drone";
import { validMotion, physicalMotion } from "./clearance";
import type { World } from "../sim/world";
import type { Vec3 } from "../sim/types";
import type { SensorId } from "./types";
import { sweptSeparation } from "./separation";
export const AVOIDANCE = {
  horizonS: 2,
  softSeparationM: 8,
  hardSeparationM: 4,
  lockS: 2,
  clearS: 1,
  clearSeparationM: 10,
  progressWindowS: 3,
  minimumProgressM: 0.5,
  maximumConflictS: 6,
  recurrenceWindowS: 15,
  recurrenceCount: 3,
  backoffM: 8,
  backoffS: 2,
  yieldSpeedMps: 3,
  priorityWeightA: 3,
  priorityWeightB: 1,
  lostProgressWeight: 2,
  bufferWeight: 12,
  yieldWeight: 0.5,
} as const;
type Aircraft = { id: SensorId; state: DroneState };
const length = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (v: Vec3): Vec3 => {
  const n = length(v);
  return n > 1e-9
    ? { x: v.x / n, y: v.y / n, z: v.z / n }
    : { x: 0, y: 0, z: 0 };
};
function limited(old: Vec3, target: Vec3, dt: number): Vec3 {
  const horizontal = Math.hypot(target.x, target.z),
    hs = Math.min(1, DRONE.maxHSpeed / Math.max(horizontal, 1e-9));
  const bounded = {
    x: target.x * hs,
    y: Math.max(-DRONE.maxVSpeed, Math.min(DRONE.maxVSpeed, target.y)),
    z: target.z * hs,
  };
  const delta = sub(bounded, old),
    scale = Math.min(1, (DRONE.maxAccel * dt) / Math.max(length(delta), 1e-9));
  return {
    x: old.x + delta.x * scale,
    y: old.y + delta.y * scale,
    z: old.z + delta.z * scale,
  };
}
function moved(
  d: Pick<DroneState, "pos">,
  v: Vec3,
  dt: number,
): Pick<DroneState, "pos" | "vel"> {
  return {
    pos: {
      x: d.pos.x + v.x * dt,
      y: d.pos.y + v.y * dt,
      z: d.pos.z + v.z * dt,
    },
    vel: v,
  };
}
/** Contact-aware team motion validator; exported for regression fixtures. */
export const clearMotion = validMotion;
export class TeamAvoidance {
  emergency = false;
  emergencyIds: SensorId[] = [];
  private active = false;
  private recentTriggers: number[] = [];
  private began = 0;
  private clearFor = 0;
  private side: Vec3 = { x: 1, y: 0, z: 0 };
  private progressStart = 0;
  private progress = 0;
  private previousB: Vec3 | null = null;
  private previousPreferred: Vec3 = { x: 0, y: 0, z: 0 };
  private backoffUntil = -Infinity;
  private lastBackoff = -Infinity;
  private backoffAnchor: Vec3 | null = null;
  readonly stats = {
    triggers: 0,
    activeSteps: 0,
    interventions: 0,
    backoffs: 0,
    deadlocks: 0,
    noFeasiblePair: 0,
    maxVelocityDeviationMps: 0,
  };
  get diagnostic() {
    return {
      active: this.active,
      side: { ...this.side },
      backoffAnchor: this.backoffAnchor ? { ...this.backoffAnchor } : null,
      backoffUntil: this.backoffUntil,
    };
  }
  apply(
    w: World,
    before: readonly Aircraft[],
    after: Aircraft[],
    t: number,
    dt: number,
    enabled = true,
    detourIds: readonly SensorId[] = [],
    detourTargets: ReadonlyMap<SensorId, Vec3> = new Map(),
  ): boolean {
    this.emergency = false;
    this.emergencyIds = [];
    if (!enabled) return false;
    const old = [...before].sort((a, b) => a.id.localeCompare(b.id)),
      next = [...after].sort((a, b) => a.id.localeCompare(b.id));
    if (old.length !== 2 || next.length !== 2)
      throw Error("Two physical aircraft required");
    const preferred = next.map((d) => ({
      x: d.state.vel.x,
      y: d.state.vel.y,
      z: d.state.vel.z,
    }));
    const forecast = sweptSeparation(
      old[0].state,
      moved(old[0].state, preferred[0], AVOIDANCE.horizonS),
      old[1].state,
      moved(old[1].state, preferred[1], AVOIDANCE.horizonS),
    );
    if (!this.active && forecast >= AVOIDANCE.softSeparationM) return false;
    if (!this.active) {
      this.active = true;
      this.began = t;
      this.lastBackoff = t;
      this.progressStart = t;
      this.progress = 0;
      this.previousB = null;
      this.clearFor = 0;
      this.stats.triggers++;
      this.recentTriggers = this.recentTriggers.filter(
        (x) => t - x < AVOIDANCE.recurrenceWindowS,
      );
      this.recentTriggers.push(t);
      if (this.recentTriggers.length >= AVOIDANCE.recurrenceCount) {
        this.progressStart = t - AVOIDANCE.progressWindowS;
        this.lastBackoff = t - AVOIDANCE.maximumConflictS;
        this.recentTriggers = [];
      }
      const r = sub(old[1].state.pos, old[0].state.pos),
        n = Math.hypot(r.x, r.z);
      // Fixed physical IDs define the A-to-B axis; this global side stays fixed throughout the episode.
      this.side =
        n > 1e-6 ? { x: -r.z / n, y: 0, z: r.x / n } : { x: 1, y: 0, z: 0 };
    }
    if (this.previousB)
      this.progress += dot(
        sub(old[1].state.pos, this.previousB),
        unit(this.previousPreferred),
      );
    this.previousB = {
      x: old[1].state.pos.x,
      y: old[1].state.pos.y,
      z: old[1].state.pos.z,
    };
    this.previousPreferred = preferred[1];
    if (forecast >= AVOIDANCE.clearSeparationM) this.clearFor += dt;
    else this.clearFor = 0;
    if (
      t - this.began >= AVOIDANCE.lockS &&
      this.clearFor >= AVOIDANCE.clearS
    ) {
      this.active = false;
      this.backoffAnchor = null;
      return false;
    }
    if (t - this.progressStart >= AVOIDANCE.progressWindowS) {
      if (
        this.progress < AVOIDANCE.minimumProgressM ||
        t - this.lastBackoff >= AVOIDANCE.maximumConflictS
      ) {
        const away = unit({
          x: old[1].state.pos.x - old[0].state.pos.x,
          y: 0,
          z: old[1].state.pos.z - old[0].state.pos.z,
        });
        const direction = length(away) > 0 ? away : this.side;
        this.backoffAnchor = {
          x: old[1].state.pos.x + direction.x * AVOIDANCE.backoffM,
          y: old[1].state.pos.y,
          z: old[1].state.pos.z + direction.z * AVOIDANCE.backoffM,
        };
        this.lastBackoff = t;
        this.backoffUntil = t + AVOIDANCE.backoffS;
        this.stats.deadlocks++;
        this.stats.backoffs++;
      }
      this.progressStart = t;
      this.progress = 0;
    }
    this.stats.activeSteps++;
    const backoff = this.backoffAnchor && t < this.backoffUntil;
    const yieldTarget = backoff
      ? { ...sub(this.backoffAnchor!, old[1].state.pos), y: preferred[1].y }
      : {
          x:
            preferred[1].x +
            this.side.x *
              (AVOIDANCE.yieldSpeedMps - dot(preferred[1], this.side)),
          y: preferred[1].y,
          z:
            preferred[1].z +
            this.side.z *
              (AVOIDANCE.yieldSpeedMps - dot(preferred[1], this.side)),
        };
    const candidates = old.map((d, i) => {
      const p = preferred[i],
        targets = [
          p,
          { x: p.x * 0.5, y: p.y, z: p.z * 0.5 },
          { x: 0, y: p.y, z: 0 },
        ];
      if (i === 1)
        targets.push(yieldTarget, {
          x: yieldTarget.x * 0.5,
          y: yieldTarget.y,
          z: yieldTarget.z * 0.5,
        });
      else
        targets.push({
          x: p.x - this.side.x * 1.5,
          y: p.y,
          z: p.z - this.side.z * 1.5,
        });
      const generated = targets
        .map((v) => moved(d.state, limited(d.state.vel, v, dt), dt))
        .filter(
          (s) =>
            clearMotion(w, d.state.pos, s.pos) &&
            (!detourTargets.has(d.id) ||
              clearMotion(w, s.pos, detourTargets.get(d.id)!)),
        );
      // Preserve the validated adapter segment exactly; do not acceleration-limit it twice.
      if (
        clearMotion(w, d.state.pos, next[i].state.pos) &&
        (!detourTargets.has(d.id) ||
          clearMotion(w, next[i].state.pos, detourTargets.get(d.id)!))
      )
        generated.unshift({
          pos: {
            x: next[i].state.pos.x,
            y: next[i].state.pos.y,
            z: next[i].state.pos.z,
          },
          vel: {
            x: next[i].state.vel.x,
            y: next[i].state.vel.y,
            z: next[i].state.vel.z,
          },
        });
      return generated;
    });
    const stationary = old.map((d) => ({
      pos: { x: d.state.pos.x, y: d.state.pos.y, z: d.state.pos.z },
      vel: { x: 0, y: 0, z: 0 },
    }));
    for (let i = 0; i < 2; i++)
      if (physicalMotion(w, old[i].state.pos, old[i].state.pos))
        candidates[i].push(stationary[i]);
    let best = Infinity,
      chosen: Pick<DroneState, "pos" | "vel">[] | null = null;
    for (const a of candidates[0])
      for (const b of candidates[1]) {
        if (
          sweptSeparation(old[0].state, a, old[1].state, b) <
          AVOIDANCE.hardSeparationM - 1e-8
        )
          continue;
        const predicted = sweptSeparation(
          old[0].state,
          moved(old[0].state, a.vel, AVOIDANCE.horizonS),
          old[1].state,
          moved(old[1].state, b.vel, AVOIDANCE.horizonS),
        );
        // Inside the soft buffer it is a cost, never an impossible requirement to teleport to 8 m.
        let cost =
          AVOIDANCE.bufferWeight *
          Math.max(0, AVOIDANCE.softSeparationM - predicted) ** 2;
        if (a === stationary[0]) cost += 1000;
        if (b === stationary[1]) cost += 1000;
        for (const [i, s] of [a, b].entries()) {
          const delta = sub(s.vel, preferred[i]),
            lost = Math.max(
              0,
              length(preferred[i]) - dot(s.vel, unit(preferred[i])),
            );
          cost +=
            (i === 0 ? AVOIDANCE.priorityWeightA : AVOIDANCE.priorityWeightB) *
              dot(delta, delta) +
            AVOIDANCE.lostProgressWeight * lost * lost;
          if (detourIds.includes(old[i].id)) cost += 10000 * lost * lost;
          const target = detourTargets.get(old[i].id);
          if (target)
            cost +=
              100000 *
              (length(sub(s.pos, target)) -
                length(sub(old[i].state.pos, target)));
        }
        const yieldDelta = sub(b.vel, yieldTarget);
        cost += AVOIDANCE.yieldWeight * dot(yieldDelta, yieldDelta);
        // Stable candidate iteration order is the final tie-break; physical source-list order is irrelevant.
        if (cost < best - 1e-12) {
          best = cost;
          chosen = [a, b];
        }
      }
    if (!chosen) {
      this.emergency = true;
      this.emergencyIds = old.map((d) => d.id);
      this.stats.noFeasiblePair++;
      for (let i = 0; i < 2; i++) {
        next[i].state.pos = {
          x: old[i].state.pos.x,
          y: old[i].state.pos.y,
          z: old[i].state.pos.z,
        };
        next[i].state.vel = { x: 0, y: 0, z: 0 };
      }
      return true;
    }
    this.emergencyIds = [];
    for (let i = 0; i < 2; i++) {
      if (chosen[i] === stationary[i]) this.emergencyIds.push(old[i].id);
      const deviation = length(sub(chosen[i].vel, preferred[i]));
      this.stats.maxVelocityDeviationMps = Math.max(
        this.stats.maxVelocityDeviationMps,
        deviation,
      );
      next[i].state.pos = chosen[i].pos;
      next[i].state.vel = chosen[i].vel;
    }
    this.emergency = this.emergencyIds.length > 0;
    this.stats.interventions++;
    // Mode/gimbal clocks keep advancing; the next observation uses corrected actual position and current camera angles.
    return true;
  }
}
