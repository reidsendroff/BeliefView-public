/** Bounded, latched clearance recovery using public geometry and aircraft motion only. */
import { DRONE, type DroneState } from "../sim/drone";
import type { World } from "../sim/world";
import type { Vec3 } from "../sim/types";
import { sweptSeparation } from "./separation";
import type { SensorId } from "./types";
import type { ExtraGeometry } from "./geometryProvider";
import {
  cylinderClearance,
  sphereClearance,
  CLEARANCE,
  clearanceState,
  validMotion,
} from "./clearance";
export const RECOVERY = {
  maxSpeedMps: 2,
  timeoutS: 3,
  retryS: 1,
  clearSteps: 3,
  exitExtraM: 0.025,
  contactTriggerS: 0.5,
  detourTimeoutS: 12,
  stationaryTimeoutS: 3,
  progressM: 0.25,
  maximumRetries: 3,
  reachM: 0.15,
  minimumProgressM: 0.5,
} as const;
type Aircraft = { id: SensorId; state: DroneState };
export interface RecoveryStatus {
  id: SensorId;
  state: "clear" | "recovering" | "blocked" | "waiting";
  since: number;
  target: Vec3 | null;
  reason: string;
  deficitM: number;
}
export const EXTENDED_RECOVERY = {
  reservationGapM: 4.5,
  reservationWaitS: 3,
  shortRadiiM: [0.25, 0.5, 1],
  intermediateCandidates: 6,
} as const;
export interface PathReservations {
  waypoints?: readonly Vec3[];
  stationary?: readonly Vec3[];
  shortFallback?: boolean;
  rejected?: () => void;
  shortUsed?: () => void;
}
function reservationAllows(a: Vec3, b: Vec3, r: PathReservations): boolean {
  if (
    [...(r.waypoints ?? []), ...(r.stationary ?? [])].some(
      (p) =>
        Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) <
        EXTENDED_RECOVERY.reservationGapM,
    ) ||
    (r.stationary ?? []).some(
      (p) =>
        sweptSeparation({ pos: a }, { pos: b }, { pos: p }, { pos: p }) <
        4 - 1e-8,
    )
  ) {
    r.rejected?.();
    return false;
  }
  return true;
}
const copy = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const norm = (p: Vec3) => Math.hypot(p.x, p.y, p.z);
export function escapeDirections(
  w: World,
  p: Vec3,
  geometry?: ExtraGeometry,
): Vec3[] {
  const dirs: Vec3[] = [];
  const normals: Vec3[] = [];
  const add = (x: number, y: number, z: number) => {
    const n = Math.hypot(x, y, z);
    if (n <= 1e-8) return null;
    const d = { x: x / n, y: y / n, z: z / n };
    if (!dirs.some((q) => Math.hypot(q.x - d.x, q.y - d.y, q.z - d.z) < 1e-6))
      dirs.push(d);
    return d;
  };
  // Includes lateral escape when opposing overlap normals cancel, and cylinder-cap escape.
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) add(x, y, z);
  for (const t of w.trees) {
    if (Math.hypot(p.x - t.x, p.z - t.z) > Math.max(t.trunkR, t.canopyR) + 3)
      continue;
    if (t.trunkR > 0 && t.trunkTop > 0) {
      const d = add(p.x - t.x, 0, p.z - t.z);
      if (d && cylinderClearance(t, p, DRONE.obstacleMargin) < 0.2)
        normals.push(d);
    }
    if (t.canopyR > 0) {
      const d = add(p.x - t.x, p.y - t.canopyY, p.z - t.z);
      if (d && sphereClearance(t, p, DRONE.obstacleMargin) < 0.2)
        normals.push(d);
    }
  }
  // Close overlapping margins can leave a narrow feasible cone missed by a fixed direction lattice.
  for (let i = 0; i < normals.length; i++)
    for (let j = i + 1; j < normals.length; j++)
      add(
        normals[i].x + normals[j].x,
        normals[i].y + normals[j].y,
        normals[i].z + normals[j].z,
      );
  for (const a of normals) {
    add(-a.z, 0, a.x);
    add(a.z, 0, -a.x);
    for (const b of normals) {
      const x = a.y * b.z - a.z * b.y,
        y = a.z * b.x - a.x * b.z,
        z = a.x * b.y - a.y * b.x;
      add(x, y, z);
      add(-x, -y, -z);
    }
  }
  for (const d of [...dirs])
    for (const rise of [0.25, 0.5, 1, 2]) add(d.x, d.y + rise, d.z);
  if (geometry)
    for (const d of geometry.escapeDirections(p)) add(d.x, d.y, d.z);
  return dirs;
}
export function recoveryTarget(
  w: World,
  p: Vec3,
  reservations: PathReservations = {},
  geometry?: ExtraGeometry,
): Vec3 | null {
  for (const r of [0.1, 0.25, 0.5, 1, 2, 4, 8])
    for (const d of escapeDirections(w, p, geometry)) {
      const q = { x: p.x + d.x * r, y: p.y + d.y * r, z: p.z + d.z * r };
      if (
        clearanceState(w, q, CLEARANCE.overshootM, geometry).minimum >=
          -CLEARANCE.epsilonM &&
        validMotion(w, p, q, geometry) &&
        reservationAllows(p, q, reservations)
      )
        return q;
    }
  return null;
}
function stepToward(
  old: DroneState,
  target: Vec3,
  dt: number,
): { pos: Vec3; vel: Vec3 } {
  const delta = {
      x: target.x - old.pos.x,
      y: target.y - old.pos.y,
      z: target.z - old.pos.z,
    },
    d = norm(delta),
    speed = Math.min(RECOVERY.maxSpeedMps, d * 2);
  const desired = {
    x: (delta.x / Math.max(d, 1e-9)) * speed,
    y: (delta.y / Math.max(d, 1e-9)) * speed,
    z: (delta.z / Math.max(d, 1e-9)) * speed,
  };
  const dv = {
      x: desired.x - old.vel.x,
      y: desired.y - old.vel.y,
      z: desired.z - old.vel.z,
    },
    scale = Math.min(1, (DRONE.maxAccel * dt) / Math.max(norm(dv), 1e-9));
  const vel = {
    x: old.vel.x + dv.x * scale,
    y: old.vel.y + dv.y * scale,
    z: old.vel.z + dv.z * scale,
  };
  return {
    vel,
    pos: {
      x: old.pos.x + vel.x * dt,
      y: old.pos.y + vel.y * dt,
      z: old.pos.z + vel.z * dt,
    },
  };
}
/** Actual progress is diagnostic. Only commanded stationary motion or the absolute cap expires an attempt. */
export class DetourProgress {
  readonly started: number;
  reference: number;
  best: number;
  lastProgress: number;
  maximumNoProgressS = 0;
  stationaryForS = 0;
  maximumStationaryS = 0;
  motion(commandedSpeed: number, displacement: number, dt: number) {
    this.stationaryForS =
      commandedSpeed > 0.1 && displacement < 1e-5
        ? this.stationaryForS + dt
        : 0;
    this.maximumStationaryS = Math.max(
      this.maximumStationaryS,
      this.stationaryForS,
    );
  }
  constructor(distance: number, t: number) {
    this.started = t;
    this.reference = distance;
    this.best = distance;
    this.lastProgress = t;
  }
  hop(distance: number, t: number) {
    this.reference = distance;
    this.best = distance;
    this.lastProgress = t;
  }
  observe(distance: number, t: number) {
    this.best = Math.min(this.best, distance);
    this.maximumNoProgressS = Math.max(
      this.maximumNoProgressS,
      t - this.lastProgress,
    );
    const threshold = Math.min(
      RECOVERY.progressM,
      Math.max(1e-6, this.reference - RECOVERY.reachM),
    );
    if (this.reference - this.best >= threshold - 1e-8) {
      this.reference = this.best;
      this.lastProgress = t;
    }
  }
  expiry(t: number): "cap" | "stall" | null {
    return t - this.started >= RECOVERY.detourTimeoutS - 1e-9
      ? "cap"
      : this.stationaryForS >= RECOVERY.stationaryTimeoutS - 1e-9
        ? "stall"
        : null;
  }
}
type Latch = {
  origin: Vec3;
  path: Vec3[];
  contact: boolean;
  retries: number;
  clock: DetourProgress;
  extended: boolean;
  pairConstrained: boolean;
};
const distance = (a: Vec3, b: Vec3) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Deterministic local search, two validated hops, never a global route guarantee. */
export function detourPath(
  w: World,
  p: Vec3,
  command: Vec3,
  contact: boolean,
  reservations: PathReservations = {},
  geometry?: ExtraGeometry,
): Vec3[] | null {
  const n = norm(command),
    forward =
      n > 1e-8
        ? { x: command.x / n, y: command.y / n, z: command.z / n }
        : { x: 0, y: 1, z: 0 };
  const candidates = (
    origin: Vec3,
    radii: readonly number[] = contact ? [2, 4] : [0.1, 0.25, 0.5, 1, 2, 4],
  ) => {
    const result: { q: Vec3; score: number; slack: number }[] = [];
    for (const d of escapeDirections(w, origin, geometry))
      for (const r of radii) {
        const q = {
          x: origin.x + d.x * r,
          y: origin.y + d.y * r,
          z: origin.z + d.z * r,
        };
        const c = clearanceState(w, q, 0, geometry);
        if (
          !c.physicalValid ||
          c.totalDeficit > CLEARANCE.epsilonM ||
          !validMotion(w, origin, q, geometry) ||
          !reservationAllows(origin, q, reservations)
        )
          continue;
        const progress =
          (q.x - p.x) * forward.x +
          (q.y - p.y) * forward.y +
          (q.z - p.z) * forward.z;
        const score =
          progress - 0.2 * distance(p, q) + 0.3 * Math.min(c.minimum, 1);
        result.push({ q, score, slack: c.minimum });
      }
    return result.sort((a, b) => b.score - a.score);
  };
  const first = candidates(p);
  const direct = first.find(
    (a) => a.slack >= CLEARANCE.overshootM - CLEARANCE.epsilonM,
  );
  if (direct) return [direct.q];
  for (const a of first.slice(0, 6)) {
    const b = candidates(a.q).find(
      (b) =>
        b.slack >= CLEARANCE.overshootM - CLEARANCE.epsilonM &&
        distance(p, b.q) >= RECOVERY.minimumProgressM + RECOVERY.reachM,
    );
    if (b) return [a.q, b.q];
  }
  // A fully valid narrow corridor need not have additional overshoot slack.
  if (contact && first.length) return [first[0].q];
  if (contact && reservations.shortFallback) {
    const minimum =
      RECOVERY.minimumProgressM + RECOVERY.reachM + CLEARANCE.epsilonM;
    const short = candidates(p, EXTENDED_RECOVERY.shortRadiiM);
    const terminal = short.filter((a) => distance(p, a.q) >= minimum);
    const direct =
      terminal.find(
        (a) => a.slack >= CLEARANCE.overshootM - CLEARANCE.epsilonM,
      ) ?? terminal[0];
    if (direct) {
      reservations.shortUsed?.();
      return [direct.q];
    }
    for (const a of short.slice(0, EXTENDED_RECOVERY.intermediateCandidates)) {
      const b = candidates(a.q, EXTENDED_RECOVERY.shortRadiiM).find(
        (b) => distance(p, b.q) >= minimum,
      );
      if (b) {
        reservations.shortUsed?.();
        return [a.q, b.q];
      }
    }
  }
  return null;
}
export class TeamRecovery {
  readonly extendedStats: {
    shortFallbacks: number;
    reservationRejectedCandidates: number;
    reservationWaits: number;
    reservationWaitTimeouts: number;
  } | null;
  private waitingSince = new Map<SensorId, number>();
  private reservationTimedOut = new Set<SensorId>();
  constructor(
    private extendedRecovery = false,
    private geometry?: ExtraGeometry,
  ) {
    this.extendedStats = extendedRecovery
      ? {
          shortFallbacks: 0,
          reservationRejectedCandidates: 0,
          reservationWaits: 0,
          reservationWaitTimeouts: 0,
        }
      : null;
  }
  private currentTime = 0;
  private states = new Map<SensorId, RecoveryStatus>();
  private clearCounts = new Map<SensorId, number>();
  private retryAt = new Map<SensorId, number>();
  private latches = new Map<SensorId, Latch>();
  private stalled = new Map<SensorId, number>();
  private attempted = new Map<SensorId, Vec3>();
  private proposed = new Map<SensorId, Vec3>();
  heldIds: SensorId[] = [];
  activeIds: SensorId[] = [];
  jointYieldIds: SensorId[] = [];
  stats = {
    entries: 0,
    exits: 0,
    timeouts: 0,
    blockedEvents: 0,
    physicalGuardInterventions: 0,
    inheritedDeficitSamples: 0,
    introducedDeficitViolations: 0,
    contactDetours: 0,
    attemptsBeyondSixSeconds: 0,
    maximumNoProgressS: 0,
    maximumCommandedStationaryS: 0,
    pairConstrainedSeconds: 0,
  };
  snapshot(): RecoveryStatus[] {
    return [...this.states.values()].map((s) => ({
      ...s,
      target: s.target ? copy(s.target) : null,
    }));
  }
  apply(
    w: World,
    before: readonly Aircraft[],
    after: Aircraft[],
    t: number,
    dt: number,
    enabled = true,
  ) {
    this.currentTime = t;
    const previouslyHeld = new Set(this.heldIds);
    this.heldIds = [];
    this.activeIds = [];
    this.jointYieldIds = [];
    this.attempted.clear();
    this.proposed.clear();
    if (!enabled) return;
    const ordered = this.extendedRecovery
      ? [...before].sort((a, b) => a.id.localeCompare(b.id))
      : before;
    for (const old of ordered) {
      const next = after.find((a) => a.id === old.id)!,
        p = old.state.pos,
        c = clearanceState(w, p, 0, this.geometry);
      const command = {
        x: next.state.pos.x - p.x,
        y: next.state.pos.y - p.y,
        z: next.state.pos.z - p.z,
      };
      this.attempted.set(old.id, copy(command));
      let s = this.states.get(old.id);
      if (!s) {
        s = {
          id: old.id,
          state: "clear",
          since: t,
          target: null,
          reason: "Desired clearance available",
          deficitM: 0,
        };
        this.states.set(old.id, s);
      }
      s.deficitM = c.totalDeficit;
      const hold = (reason: string) => {
        next.state.pos = copy(p);
        next.state.vel = { x: 0, y: 0, z: 0 };
        this.heldIds.push(old.id);
        s!.reason = reason;
      };
      if (!c.physicalValid) {
        if (s.state !== "blocked") this.stats.blockedEvents++;
        s.state = "blocked";
        s.target = null;
        hold("Invalid physical start; no valid stationary or escape claim");
        continue;
      }
      if (c.totalDeficit > CLEARANCE.epsilonM)
        this.stats.inheritedDeficitSamples++;
      let latch = this.latches.get(old.id);
      if (
        s.state === "blocked" &&
        (t < (this.retryAt.get(old.id) ?? 0) ||
          (latch?.retries ?? 0) >= RECOVERY.maximumRetries)
      ) {
        hold("No safe local move found; bounded retry exhausted or pending");
        continue;
      }
      const rejected = !validMotion(w, p, next.state.pos, this.geometry);
      const contact = c.totalDeficit <= CLEARANCE.epsilonM;
      if (
        s.state === "blocked" ||
        s.state === "waiting" ||
        (s.state === "clear" &&
          (rejected ||
            !contact ||
            (this.stalled.get(old.id) ?? 0) >= RECOVERY.contactTriggerS))
      ) {
        const reservations: PathReservations = this.extendedRecovery
          ? {
              shortFallback: true,
              waypoints: before
                .filter((a) => a.id !== old.id)
                .flatMap((a) => {
                  const state = this.states.get(a.id),
                    other = this.latches.get(a.id);
                  return state?.state === "recovering" && state.target
                    ? (other?.path ?? [])
                    : [];
                }),
              stationary: before
                .filter(
                  (a) =>
                    a.id !== old.id &&
                    (this.states.get(a.id)?.state === "blocked" ||
                      this.states.get(a.id)?.state === "waiting" ||
                      this.heldIds.includes(a.id) ||
                      previouslyHeld.has(a.id)),
                )
                .map((a) => copy(a.state.pos)),
              rejected: () => {
                this.extendedStats!.reservationRejectedCandidates++;
              },
              shortUsed: () => {
                this.extendedStats!.shortFallbacks++;
              },
            }
          : {};
        const findPath = (r: PathReservations) =>
          contact
            ? detourPath(w, p, command, true, r, this.geometry)
            : (() => {
                const q = recoveryTarget(w, p, r, this.geometry);
                return q
                  ? [q]
                  : detourPath(w, p, command, false, r, this.geometry);
              })();
        const path = findPath(reservations);
        const reservationExpired = this.reservationTimedOut.has(old.id);
        if (!path && reservationExpired) {
          this.retryAt.set(old.id, t + RECOVERY.retryS);
          hold("Reservation wait expired; no newly available safe path");
          continue;
        }
        if (
          !path &&
          this.extendedRecovery &&
          (reservations.waypoints?.length ?? 0) +
            (reservations.stationary?.length ?? 0) >
            0 &&
          findPath({ shortFallback: true })
        ) {
          const since = this.waitingSince.get(old.id) ?? t;
          if (!this.waitingSince.has(old.id)) {
            this.waitingSince.set(old.id, since);
            this.extendedStats!.reservationWaits++;
          }
          s.target = null;
          s.since = since;
          if (t - since >= EXTENDED_RECOVERY.reservationWaitS - 1e-9) {
            s.state = "blocked";
            this.stats.blockedEvents++;
            this.reservationTimedOut.add(old.id);
            this.extendedStats!.reservationWaitTimeouts++;
            this.retryAt.set(old.id, t + RECOVERY.retryS);
            hold("Bounded wait for a teammate detour expired");
          } else {
            s.state = "waiting";
            hold("Waiting for a live teammate detour reservation");
          }
          continue;
        }
        this.waitingSince.delete(old.id);
        this.reservationTimedOut.delete(old.id);
        latch = {
          origin: copy(p),
          path: path ?? [],
          contact,
          retries:
            (latch?.retries ?? 0) +
            (s.state === "blocked" && !reservationExpired ? 1 : 0),
          clock: new DetourProgress(path?.[0] ? distance(p, path[0]) : 0, t),
          extended: false,
          pairConstrained: false,
        };
        this.latches.set(old.id, latch);
        s.state = "recovering";
        s.since = t;
        s.target = path?.[0] ?? null;
        s.reason = contact
          ? "Following a latched public-map contact detour"
          : "Recovering existing clearance deficit";
        this.stats.entries++;
        if (contact) this.stats.contactDetours++;
        if (rejected) this.stats.physicalGuardInterventions++;
        this.clearCounts.set(old.id, 0);
        this.stalled.set(old.id, 0);
      }
      if (s.state !== "recovering") continue;
      latch = this.latches.get(old.id)!;
      if (
        s.target &&
        distance(p, s.target) <= RECOVERY.reachM &&
        latch.path.length > 1
      ) {
        latch.path.shift();
        s.target = latch.path[0];
        latch.clock.hop(distance(p, s.target), t);
      }
      if (s.target) latch.clock.observe(distance(p, s.target), t);
      this.stats.maximumNoProgressS = Math.max(
        this.stats.maximumNoProgressS,
        latch.clock.maximumNoProgressS,
      );
      if (t - s.since > 6 && !latch.extended) {
        latch.extended = true;
        this.stats.attemptsBeyondSixSeconds++;
      }
      const clear =
        clearanceState(w, p, RECOVERY.exitExtraM, this.geometry).minimum >=
        -CLEARANCE.epsilonM;
      const reached =
        !!s.target &&
        distance(p, s.target) <= RECOVERY.reachM &&
        distance(p, latch.origin) >= RECOVERY.minimumProgressM;
      const count = clear ? (this.clearCounts.get(old.id) ?? 0) + 1 : 0;
      this.clearCounts.set(old.id, count);
      if (
        latch.contact
          ? reached && c.totalDeficit <= CLEARANCE.epsilonM
          : count >= RECOVERY.clearSteps
      ) {
        s.state = "clear";
        s.target = null;
        s.reason = "Local clearance detour complete";
        this.stats.exits++;
        this.latches.delete(old.id);
      } else if (
        !s.target ||
        (latch.contact
          ? latch.clock.expiry(t) !== null
          : t - s.since >= RECOVERY.timeoutS - 1e-9)
      ) {
        s.state = "blocked";
        s.reason = !s.target
          ? "No safe local candidate found within bounded search"
          : latch.clock.expiry(t) === "cap"
            ? "Local detour absolute cap exceeded"
            : latch.pairConstrained
              ? "Commanded stationary timeout during a joint yield"
              : "Local commanded stationary timeout";
        this.stats.blockedEvents++;
        if (s.target) this.stats.timeouts++;
        this.retryAt.set(old.id, t + RECOVERY.retryS);
        s.target = null;
        hold(s.reason);
        continue;
      } else {
        const motion = stepToward(old.state, s.target, dt);
        this.activeIds.push(old.id);
        if (
          validMotion(w, p, motion.pos, this.geometry) &&
          validMotion(w, motion.pos, s.target, this.geometry)
        ) {
          next.state.pos = motion.pos;
          next.state.vel = motion.vel;
          s.reason = latch.pairConstrained
            ? "Following local detour after a joint yield"
            : "Following validated local detour";
        } else hold("Braking before local clearance detour");
        this.proposed.set(old.id, copy(next.state.pos));
        continue;
      }
      // On the exit tick the inherited command still passes the all-motion guard.
      if (!validMotion(w, p, next.state.pos, this.geometry))
        hold("Pausing before the next public-map detour");
    }
  }
  /** Final-motion history, after joint avoidance; partner-only yields do not trigger geometry detours. */
  audit(
    w: World,
    before: readonly Aircraft[],
    after: readonly Aircraft[],
    dt = 0.05,
    t = this.currentTime,
  ) {
    for (const old of before) {
      const next = after.find((a) => a.id === old.id)!,
        p = old.state.pos,
        command = this.attempted.get(old.id);
      if (!command) continue;
      const latch = this.latches.get(old.id),
        state = this.states.get(old.id),
        proposal = this.proposed.get(old.id);
      if (latch && state?.target && proposal) {
        const proposedGain =
          distance(p, state.target) - distance(proposal, state.target);
        const actualGain =
          distance(p, state.target) - distance(next.state.pos, state.target);
        latch.pairConstrained =
          proposedGain > 1e-5 &&
          actualGain < proposedGain - 1e-5 &&
          validMotion(w, p, proposal, this.geometry);
        if (latch.pairConstrained) {
          this.stats.pairConstrainedSeconds += dt;
          this.jointYieldIds.push(old.id);
          state.reason = "Joint avoidance is yielding during the local detour";
        }
        latch.clock.observe(distance(next.state.pos, state.target), t + dt);
        latch.clock.motion(norm(command) / dt, distance(p, next.state.pos), dt);
        this.stats.maximumCommandedStationaryS = Math.max(
          this.stats.maximumCommandedStationaryS,
          latch.clock.maximumStationaryS,
        );
        this.stats.maximumNoProgressS = Math.max(
          this.stats.maximumNoProgressS,
          latch.clock.maximumNoProgressS,
        );
      }
      if (!validMotion(w, p, next.state.pos, this.geometry))
        this.stats.introducedDeficitViolations++;
      const q = { x: p.x + command.x, y: p.y + command.y, z: p.z + command.z };
      const geometry = !validMotion(w, p, q, this.geometry);
      const stalled =
        geometry &&
        norm(command) / dt > 0.1 &&
        distance(p, next.state.pos) < 1e-5;
      this.stalled.set(
        old.id,
        stalled ? (this.stalled.get(old.id) ?? 0) + dt : 0,
      );
    }
  }
}
