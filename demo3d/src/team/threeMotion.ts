/** One N3 motion tuple, checked against every physical segment and every swept pair. */
import { DRONE, type DroneState } from "../sim/drone";
import type { Vec3 } from "../sim/types";
import type { World } from "../sim/world";
import type { Aircraft } from "./planner";
import type { SensorId } from "./types";
import { THREE } from "./threeConstants";
import { validMotion, physicalMotion } from "./clearance";
import type { ExtraGeometry } from "./geometryProvider";
import { RECOVERY } from "./recovery";
import { sweptSeparation } from "./separation";
const clone = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const length = (p: Vec3) => Math.hypot(p.x, p.y, p.z);
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (v: Vec3) => {
  const n = length(v) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
};
const moved = (p: Vec3, v: Vec3, dt: number): Vec3 => ({
  x: p.x + v.x * dt,
  y: p.y + v.y * dt,
  z: p.z + v.z * dt,
});
function limited(old: Vec3, target: Vec3, dt: number): Vec3 {
  const scale = Math.min(
    1,
    DRONE.maxHSpeed / Math.max(1e-9, Math.hypot(target.x, target.z)),
  );
  const bounded = {
    x: target.x * scale,
    y: Math.max(-DRONE.maxVSpeed, Math.min(DRONE.maxVSpeed, target.y)),
    z: target.z * scale,
  };
  const d = sub(bounded, old),
    k = Math.min(1, (DRONE.maxAccel * dt) / Math.max(length(d), 1e-9));
  return { x: old.x + d.x * k, y: old.y + d.y * k, z: old.z + d.z * k };
}
export function allPairSweeps(
  before: readonly { id: SensorId; state: Pick<DroneState, "pos"> }[],
  after: readonly { id: SensorId; state: Pick<DroneState, "pos"> }[],
) {
  const result: { pair: string; distance: number }[] = [];
  const old = [...before].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < old.length; i++)
    for (let j = i + 1; j < old.length; j++) {
      const a = after.find((d) => d.id === old[i].id),
        b = after.find((d) => d.id === old[j].id);
      if (!a || !b) throw Error("Missing physical drone in joint motion");
      result.push({
        pair: old[i].id + old[j].id,
        distance: sweptSeparation(old[i].state, a.state, old[j].state, b.state),
      });
    }
  return result;
}
interface Candidate {
  pos: Vec3;
  vel: Vec3;
  cost: number;
  emergency: boolean;
}
export interface ThreeMotionOptions {
  protectDetours?: boolean;
  fullEscalationBand?: boolean;
  detourOwner?: boolean;
}
/** Non-renewable per-target protection. Only actual net new approach distance resets the clock. */
export class DetourProgress {
  private records = new Map<
    SensorId,
    {
      key: string;
      best: number;
      credited: number;
      since: number;
      firstSeen: number;
      expiredAt: number | null;
      endedAt: number | null;
      queuedAt: number | null;
      firstServiceAt: number | null;
      expired: boolean;
    }
  >();
  update(
    id: SensorId,
    target: Vec3,
    remaining: number,
    now: number,
    valid: boolean,
  ): boolean {
    const key = [target.x, target.y, target.z].join(",");
    let record = this.records.get(id);
    if (!record || record.key !== key) {
      record = {
        key,
        best: remaining,
        credited: remaining,
        since: now,
        firstSeen: now,
        expiredAt: null,
        endedAt: null,
        queuedAt: null,
        firstServiceAt: null,
        expired: false,
      };
      this.records.set(id, record);
    }
    if ((!valid || remaining <= RECOVERY.reachM) && !record.expired) {
      record.expired = true;
      record.endedAt = now;
    }
    if (record.expired) return false;
    // Only genuinely queued, never-served targets defer this internal priority clock.
    // Recovery's absolute/stationary deadlines remain independent and keep running.
    if (record.queuedAt !== null && record.firstServiceAt === null) return true;
    record.best = Math.min(record.best, remaining);
    const required = Math.min(
      THREE.progressM,
      Math.max(1e-6, record.credited - RECOVERY.reachM),
    );
    if (record.credited - record.best >= required - 1e-9) {
      record.credited = record.best;
      record.since = now;
    }
    if (now - record.since >= THREE.progressS - 1e-9) {
      record.expired = true;
      record.expiredAt = now;
      record.endedAt = now;
    }
    return !record.expired;
  }
  retain(active: ReadonlySet<SensorId>) {
    for (const id of this.records.keys())
      if (!active.has(id)) this.records.delete(id);
  }
  queued(id: SensorId, now: number) {
    const r = this.records.get(id);
    if (r && !r.expired && r.firstServiceAt === null && r.queuedAt === null)
      r.queuedAt = now;
  }
  serve(id: SensorId, remaining: number, now: number) {
    const r = this.records.get(id);
    if (!r || r.expired || r.firstServiceAt !== null) return;
    if (r.queuedAt !== null) {
      r.best = remaining;
      r.credited = remaining;
      r.since = now;
    }
    r.firstServiceAt = now;
  }
  snapshot(id: SensorId, now: number) {
    const r = this.records.get(id);
    return r
      ? {
          id,
          targetKey: r.key,
          firstSeen: r.firstSeen,
          queuedAt: r.queuedAt,
          firstServiceAt: r.firstServiceAt,
          expired: r.expired,
          progressExpiredAt: r.expiredAt,
          pendingFirstService:
            r.queuedAt !== null && r.firstServiceAt === null && !r.expired,
          queueWaitS:
            r.queuedAt === null
              ? 0
              : Math.max(
                  0,
                  (r.firstServiceAt ?? r.endedAt ?? now) - r.queuedAt,
                ),
          progressClockS:
            r.queuedAt !== null && r.firstServiceAt === null
              ? 0
              : Math.max(0, (r.endedAt ?? now) - r.since),
        }
      : null;
  }
  firstSeen(id: SensorId) {
    return this.records.get(id)?.firstSeen ?? Infinity;
  }
  stalledAt(id: SensorId) {
    return this.records.get(id)?.expiredAt;
  }
}
/** Evaluate the global minimum first; epsilon admission never depends on iteration order. */
export function ownerTier<
  T extends { ownerDeviation: number; cost: number; order: number },
>(rows: readonly T[]): T | null {
  if (!rows.length) return null;
  const minimum = Math.min(...rows.map((r) => r.ownerDeviation));
  return rows
    .filter(
      (r) =>
        r.ownerDeviation <= minimum + THREE.ownerDeviationToleranceMps + 1e-12,
    )
    .reduce((best, r) =>
      r.cost < best.cost - 1e-12 ||
      (Math.abs(r.cost - best.cost) <= 1e-12 && r.order < best.order)
        ? r
        : best,
    );
}
export class ThreeMotion {
  private detourProgress = new DetourProgress();
  private protectedIds: SensorId[] = [];
  private ownerId: SensorId | null = null;
  private ownerRemainingM: number | null = null;
  private ownerAppliedLastStep = false;
  private queueNow = 0;
  private activeDetourIds: SensorId[] = [];
  constructor(
    private options: ThreeMotionOptions = {},
    private geometry?: ExtraGeometry,
  ) {}
  emergencyIds: SensorId[] = [];
  replanRequested = false;
  private active = false;
  private candidateCounts: { id: SensorId; count: number }[] = [];
  private began = 0;
  private clearFor = 0;
  private lastBackoff = -Infinity;
  private anchors = new Map<SensorId, Vec3>();
  private anchorUntil = -Infinity;
  private sides = new Map<string, Vec3>();
  private progressAt = 0;
  private progress = new Map<SensorId, number>();
  private previous = new Map<SensorId, { pos: Vec3; preferred: Vec3 }>();
  readonly stats = {
    triggers: 0,
    activeSteps: 0,
    interventions: 0,
    backoffs: 0,
    replanRequests: 0,
    noFeasibleTriple: 0,
    emergencyHolds: 0,
    maxCandidateCount: 0,
    maxVelocityDeviationMps: 0,
    protectedSeconds: { A: 0, B: 0, C: 0 },
    ownerSteps: { A: 0, B: 0, C: 0 },
    ownerHandoffs: 0,
    nonOwnerProgressExpiries: { A: 0, B: 0, C: 0 },
    queuedSeconds: { A: 0, B: 0, C: 0 },
    maxQueueWaitS: { A: 0, B: 0, C: 0 },
    maxOwnerProgressClockS: { A: 0, B: 0, C: 0 },
  };
  get diagnostic() {
    return {
      active: this.active,
      protectedIds: [...this.protectedIds],
      ownerId: this.ownerId,
      ownerRemainingM: this.ownerRemainingM,
      detourQueue: this.activeDetourIds
        .map((id) => this.detourProgress.snapshot(id, this.queueNow))
        .filter((r) => r !== null),
      anchors: [...this.anchors].map(([id, pos]) => ({ id, pos: clone(pos) })),
      anchorUntil: Number.isFinite(this.anchorUntil) ? this.anchorUntil : null,
      replanRequested: this.replanRequested,
      candidateCounts: this.candidateCounts.map((c) => ({
        id: c.id,
        count: c.count,
      })),
    };
  }
  apply(
    w: World,
    before: readonly Aircraft[],
    after: Aircraft[],
    now: number,
    dt: number,
    detourTargets: ReadonlyMap<SensorId, Vec3> = new Map(),
  ): boolean {
    this.emergencyIds = [];
    this.replanRequested = false;
    this.candidateCounts = [];
    const old = [...before].sort((a, b) => a.id.localeCompare(b.id)),
      next = [...after].sort((a, b) => a.id.localeCompare(b.id));
    if (
      old.length !== 3 ||
      next.length !== 3 ||
      old.map((d) => d.id).join("") !== "ABC" ||
      next.map((d) => d.id).join("") !== "ABC"
    )
      throw Error("Exact A/B/C physical cohort required");
    if (
      old.some(
        (d) => !physicalMotion(w, d.state.pos, d.state.pos, this.geometry),
      ) ||
      allPairSweeps(old, old).some(
        (p) => p.distance < THREE.hardSeparationM - 1e-8,
      )
    )
      throw Error("Invalid three-drone physical/pair start");
    this.queueNow = now;
    this.activeDetourIds = old
      .filter((d) => detourTargets.has(d.id))
      .map((d) => d.id);
    this.detourProgress.retain(new Set(this.activeDetourIds));
    const updateQueueStats = () => {
      for (const id of this.activeDetourIds) {
        const r = this.detourProgress.snapshot(id, now);
        if (!r) continue;
        if (r.pendingFirstService) this.stats.queuedSeconds[id] += dt;
        this.stats.maxQueueWaitS[id] = Math.max(
          this.stats.maxQueueWaitS[id],
          r.queueWaitS,
        );
        if (r.firstServiceAt !== null)
          this.stats.maxOwnerProgressClockS[id] = Math.max(
            this.stats.maxOwnerProgressClockS[id],
            r.progressClockS,
          );
      }
    };
    this.protectedIds =
      this.options.protectDetours === false
        ? []
        : old
            .filter((d) => {
              const target = detourTargets.get(d.id);
              return (
                target &&
                this.detourProgress.update(
                  d.id,
                  target,
                  length(sub(target, d.state.pos)),
                  now,
                  validMotion(w, d.state.pos, target, this.geometry),
                )
              );
            })
            .map((d) => d.id);
    const previousOwner = this.ownerId;
    const previousOwnerApplied = this.ownerAppliedLastStep;
    this.ownerAppliedLastStep = false;
    this.ownerId =
      this.options.detourOwner === false
        ? null
        : ([...this.protectedIds].sort(
            (a, b) =>
              this.detourProgress.firstSeen(a) -
                this.detourProgress.firstSeen(b) || a.localeCompare(b),
          )[0] ?? null);
    if (previousOwner && this.ownerId && previousOwner !== this.ownerId)
      this.stats.ownerHandoffs++;
    this.ownerRemainingM = this.ownerId
      ? length(
          sub(
            detourTargets.get(this.ownerId)!,
            old.find((d) => d.id === this.ownerId)!.state.pos,
          ),
        )
      : null;
    for (const d of old)
      if (
        previousOwnerApplied &&
        previousOwner &&
        d.id !== previousOwner &&
        this.detourProgress.stalledAt(d.id) === now
      )
        this.stats.nonOwnerProgressExpiries[d.id]++;
    const ownerIndex = this.ownerId
      ? old.findIndex((d) => d.id === this.ownerId)
      : -1;
    const preferred = next.map((d) => clone(d.state.vel));
    const forecast = (i: number, j: number, a: Vec3, b: Vec3) =>
      sweptSeparation(
        old[i].state,
        { pos: moved(old[i].state.pos, a, THREE.forecastS) },
        old[j].state,
        { pos: moved(old[j].state.pos, b, THREE.forecastS) },
      );
    let closest = Infinity;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        closest = Math.min(closest, forecast(i, j, preferred[i], preferred[j]));
    const currentValid =
      next.every((d, i) =>
        validMotion(w, old[i].state.pos, d.state.pos, this.geometry),
      ) &&
      allPairSweeps(old, next).every(
        (p) => p.distance >= THREE.hardSeparationM,
      );
    if (!this.active && closest >= THREE.softSeparationM && currentValid) {
      updateQueueStats();
      return false;
    }
    if (!this.active) {
      this.active = true;
      this.began = now;
      this.progressAt = now;
      this.clearFor = 0;
      this.stats.triggers++;
      this.sides.clear();
      this.progress.clear();
      this.previous.clear();
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const r = sub(old[j].state.pos, old[i].state.pos),
            n = Math.hypot(r.x, r.z) || 1;
          this.sides.set(old[i].id + old[j].id, {
            x: -r.z / n,
            y: 0,
            z: r.x / n,
          });
        }
    }
    for (let i = 0; i < 3; i++) {
      const prev = this.previous.get(old[i].id);
      if (prev)
        this.progress.set(
          old[i].id,
          (this.progress.get(old[i].id) ?? 0) +
            dot(sub(old[i].state.pos, prev.pos), unit(prev.preferred)),
        );
      this.previous.set(old[i].id, {
        pos: clone(old[i].state.pos),
        preferred: clone(preferred[i]),
      });
    }
    this.clearFor = closest >= THREE.clearSeparationM ? this.clearFor + dt : 0;
    if (
      now - this.began >= THREE.lockS &&
      this.clearFor >= THREE.clearS &&
      currentValid
    ) {
      this.active = false;
      this.anchors.clear();
      updateQueueStats();
      return false;
    }
    this.stats.activeSteps++;
    // Applied service is recorded only after a feasible owner-tier tuple is selected below.
    for (const id of this.protectedIds) this.stats.protectedSeconds[id] += dt;
    const stalled =
      now - this.progressAt >= THREE.progressS &&
      old.some((d) => (this.progress.get(d.id) ?? 0) < THREE.progressM);
    if (
      (stalled || now - this.began >= THREE.conflictS) &&
      now - this.lastBackoff >= THREE.conflictS
    ) {
      this.lastBackoff = now;
      this.anchorUntil = now + THREE.backoffS;
      this.anchors.clear();
      this.stats.backoffs++;
      // Each physical ID gets a fixed outward anchor. Stable fallback angles resolve a zero centroid direction.
      for (let i = 0; i < 3; i++) {
        if (this.protectedIds.includes(old[i].id)) continue;
        const peers = old.filter((_, j) => j !== i),
          center = {
            x: (peers[0].state.pos.x + peers[1].state.pos.x) / 2,
            y: old[i].state.pos.y,
            z: (peers[0].state.pos.z + peers[1].state.pos.z) / 2,
          };
        let away = unit(sub(old[i].state.pos, center));
        if (length(away) < 1e-8)
          away = {
            x: Math.cos((i * 2 * Math.PI) / 3),
            y: 0,
            z: Math.sin((i * 2 * Math.PI) / 3),
          };
        this.anchors.set(
          old[i].id,
          moved(old[i].state.pos, away, THREE.backoffM),
        );
      }
      this.progressAt = now;
      this.progress.clear();
    }
    if (
      now - this.began >= THREE.conflictS + THREE.backoffS &&
      now >= this.anchorUntil &&
      closest <
        (this.options.fullEscalationBand === false
          ? THREE.softSeparationM
          : THREE.clearSeparationM)
    ) {
      this.replanRequested = true;
      this.stats.replanRequests++;
      this.began = now;
    }
    const lists = old.map((d, i) => {
      const out: Candidate[] = [],
        target = detourTargets.get(d.id),
        oldChord = target
          ? validMotion(w, d.state.pos, target, this.geometry)
          : false;
      const protectedDetour = this.protectedIds.includes(d.id);
      const anchor = protectedDetour ? undefined : this.anchors.get(d.id);
      const scoringVelocity =
        anchor && now < this.anchorUntil
          ? moved({ x: 0, y: 0, z: 0 }, unit(sub(anchor, d.state.pos)), 3)
          : preferred[i];
      const add = (pos: Vec3, vel: Vec3, emergency = false) => {
        if (out.some((c) => length(sub(c.pos, pos)) < 1e-9)) return;
        if (!validMotion(w, d.state.pos, pos, this.geometry)) return;
        if (target && oldChord && !validMotion(w, pos, target, this.geometry))
          return;
        const deviation = length(sub(vel, scoringVelocity)),
          forward = Math.max(
            0,
            length(scoringVelocity) - dot(vel, unit(scoringVelocity)),
          );
        out.push({
          pos,
          vel,
          cost:
            (protectedDetour
              ? Math.max(...Object.values(THREE.priority))
              : THREE.priority[d.id]) *
              deviation *
              deviation +
            THREE.lostProgressWeight * forward +
            (emergency ? 1000 : 0),
          emergency,
        });
      };
      add(clone(next[i].state.pos), clone(next[i].state.vel));
      const velocity = (want: Vec3) => {
        const v = limited(d.state.vel, want, dt);
        add(moved(d.state.pos, v, dt), v);
      };
      velocity({ x: 0, y: 0, z: 0 });
      for (let j = 0; j < 3; j++)
        if (j !== i) {
          const key = [d.id, old[j].id].sort().join(""),
            side = this.sides.get(key)!,
            sign = d.id < old[j].id ? 1 : -1;
          for (const s of [sign, -sign])
            velocity({
              x: preferred[i].x + side.x * s * 3,
              y: preferred[i].y,
              z: preferred[i].z + side.z * s * 3,
            });
          const away = unit(sub(d.state.pos, old[j].state.pos));
          velocity({ x: away.x * 3, y: 0, z: away.z * 3 });
        }
      if (anchor && now < this.anchorUntil) {
        const v = unit(sub(anchor, d.state.pos));
        velocity({ x: v.x * 3, y: v.y * 3, z: v.z * 3 });
      }
      for (const sign of [1, -1]) velocity({ x: sign * 3, y: 0, z: 0 });
      add(clone(d.state.pos), { x: 0, y: 0, z: 0 }, true);
      // Always retain the explicitly validated stationary fallback, even when other candidates fill the budget.
      const stop = out.find((c) => c.emergency);
      const bounded = out
        .filter((c) => !c.emergency)
        .slice(0, THREE.motionCandidates - 1);
      if (stop) bounded.push(stop);
      this.stats.maxCandidateCount = Math.max(
        this.stats.maxCandidateCount,
        bounded.length,
      );
      return bounded;
    });
    this.candidateCounts = old.map((d, i) => ({
      id: d.id,
      count: lists[i].length,
    }));
    const compatibility = new Map<
      string,
      { valid: boolean; penalty: number }
    >();
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        for (let a = 0; a < lists[i].length; a++)
          for (let b = 0; b < lists[j].length; b++) {
            const x = lists[i][a],
              y = lists[j][b],
              separation = sweptSeparation(
                old[i].state,
                { pos: x.pos },
                old[j].state,
                { pos: y.pos },
              ),
              future = forecast(i, j, x.vel, y.vel);
            compatibility.set(i + ":" + a + "|" + j + ":" + b, {
              valid: separation >= THREE.hardSeparationM,
              penalty:
                THREE.bufferWeight *
                (Math.max(0, THREE.softSeparationM - future) /
                  THREE.softSeparationM) **
                  2,
            });
          }
    const ownerTuples: {
      cs: Candidate[];
      cost: number;
      ownerDeviation: number;
      order: number;
    }[] = [];
    let best: Candidate[] | null = null,
      bestCost = Infinity;
    for (let a = 0; a < lists[0].length; a++)
      for (let b = 0; b < lists[1].length; b++)
        for (let c = 0; c < lists[2].length; c++) {
          const ab = compatibility.get("0:" + a + "|1:" + b)!,
            ac = compatibility.get("0:" + a + "|2:" + c)!,
            bc = compatibility.get("1:" + b + "|2:" + c)!;
          if (!ab.valid || !ac.valid || !bc.valid) continue;
          const cs = [lists[0][a], lists[1][b], lists[2][c]],
            cost =
              cs.reduce((s, v) => s + v.cost, 0) +
              ab.penalty +
              ac.penalty +
              bc.penalty;
          if (ownerIndex >= 0)
            ownerTuples.push({
              cs,
              cost,
              ownerDeviation: length(
                sub(cs[ownerIndex].vel, preferred[ownerIndex]),
              ),
              order: ownerTuples.length,
            });
          if (cost < bestCost - 1e-12) {
            best = cs;
            bestCost = cost;
          }
        }
    if (ownerIndex >= 0) best = ownerTier(ownerTuples)?.cs ?? null;
    if (!best) {
      this.stats.noFeasibleTriple++;
      const fallbackTuples: typeof ownerTuples = [];
      // Explicit eight-subset fallback, rechecked globally. Geometry never gets a waiver.
      for (let mask = 7; mask >= 0 && (!best || ownerIndex >= 0); mask--) {
        const cs = old.map((d, i) =>
          mask & (1 << i)
            ? {
                pos: clone(next[i].state.pos),
                vel: clone(next[i].state.vel),
                cost: 0,
                emergency: false,
              }
            : {
                pos: clone(d.state.pos),
                vel: { x: 0, y: 0, z: 0 },
                cost: 0,
                emergency: true,
              },
        );
        if (
          cs.every((c, i) => {
            const target = detourTargets.get(old[i].id);
            return (
              validMotion(w, old[i].state.pos, c.pos, this.geometry) &&
              (!target ||
                !validMotion(w, old[i].state.pos, target, this.geometry) ||
                validMotion(w, c.pos, target, this.geometry))
            );
          }) &&
          allPairSweeps(
            old,
            cs.map((c, i) => ({ id: old[i].id, state: { pos: c.pos } })),
          ).every((p) => p.distance >= THREE.hardSeparationM)
        ) {
          if (ownerIndex >= 0)
            fallbackTuples.push({
              cs,
              cost: 0,
              ownerDeviation: length(
                sub(cs[ownerIndex].vel, preferred[ownerIndex]),
              ),
              order: 7 - mask,
            });
          else best = cs;
        }
      }
      if (ownerIndex >= 0) best = ownerTier(fallbackTuples)?.cs ?? null;
      if (!best) throw Error("No safe local move found from three-drone start");
    }
    if (this.ownerId && ownerIndex >= 0) {
      this.ownerAppliedLastStep = true;
      this.stats.ownerSteps[this.ownerId]++;
      for (const id of this.protectedIds)
        if (id !== this.ownerId) this.detourProgress.queued(id, now);
      this.detourProgress.serve(this.ownerId, this.ownerRemainingM!, now);
    }
    updateQueueStats();
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const c = best[i];
      changed ||= length(sub(c.pos, next[i].state.pos)) > 1e-9;
      this.stats.maxVelocityDeviationMps = Math.max(
        this.stats.maxVelocityDeviationMps,
        length(sub(c.vel, preferred[i])),
      );
      const stoppedCommand =
        length(sub(c.pos, old[i].state.pos)) < 1e-8 &&
        length(sub(next[i].state.pos, old[i].state.pos)) > 1e-8;
      next[i].state.pos = clone(c.pos);
      next[i].state.vel = clone(c.vel);
      if (c.emergency || stoppedCommand) {
        this.emergencyIds.push(next[i].id);
        this.stats.emergencyHolds++;
      }
    }
    if (changed) this.stats.interventions++;
    if (
      !next.every((d, i) =>
        validMotion(w, old[i].state.pos, d.state.pos, this.geometry),
      ) ||
      allPairSweeps(old, next).some((p) => p.distance < THREE.hardSeparationM)
    )
      throw Error("Joint motion recheck failed");
    return changed;
  }
}
