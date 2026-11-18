/** Explicit teammate investigation. Inputs are accepted public packets, own fixes and known geometry only. */
import type { TrackerSnapshot } from "../sim/types";
import { DRONE } from "../sim/drone";
import { fovTest } from "../sim/sensor";
import { lineOfSight } from "../sim/geometry";
import { validMotion } from "./clearance";
import type { Evidence, SensorId } from "./types";
import type { Aircraft, Allocation, TeamPlanner } from "./planner";
import type { TeamMap } from "./map";
export const ASSIST = {
  ownRecentS: 1.5,
  freshnessS: 3,
  refreshS: 1.5,
  minimumRefreshS: 0.5,
  cueShiftM: 4,
  uncertaintyGrowthMps: 2,
  minStandoffM: 10,
  maxStandoffM: 24,
  sourceSpacingM: 8,
  minimumAngleRad: Math.PI / 4,
  routeShortlist: 14,
  arrivalM: 2,
  dwellS: 2,
  cooldownS: 3,
} as const;
export const hasRecentOwnFix = (
  track: Pick<TrackerSnapshot, "initialised" | "age">,
) => track.initialised && track.age <= ASSIST.ownRecentS;
export interface AssistStatus {
  id: SensorId;
  state:
    "investigating" | "confirmed" | "expired" | "unavailable" | "dwell-expired";
  source?: SensorId;
  sensedAt?: number;
  x?: number;
  z?: number;
  sigma?: number;
  uncertaintyM?: number;
  goal?: { x: number; z: number };
  sampledSupport?: number;
  reason: string;
}
interface Active {
  status: AssistStatus;
  allocation: Allocation;
  refreshedAt: number;
  anchor: { x: number; z: number };
  arrivedAt: number | null;
}
interface Candidate {
  x: number;
  z: number;
  support: number;
  angle: number;
  distance: number;
}
export class TeamAssist {
  private latest = new Map<SensorId, Evidence>();
  private active = new Map<SensorId, Active>();
  private status = new Map<SensorId, AssistStatus>();
  private retryAt = new Map<SensorId, number>();
  stats = {
    dispatches: 0,
    refreshes: 0,
    confirmations: 0,
    expired: 0,
    unavailable: 0,
    dwellExpired: 0,
  };
  constructor(
    private map: TeamMap,
    private planner: TeamPlanner,
  ) {}
  private candidate(
    x: number,
    z: number,
    drone: Aircraft,
    source: Aircraft,
    cue: Evidence,
    now: number,
  ): Candidate | null {
    const o = cue.observation!;
    const range = Math.hypot(x - o.x, z - o.z);
    if (
      range < ASSIST.minStandoffM ||
      range > ASSIST.maxStandoffM ||
      Math.hypot(x - source.state.pos.x, z - source.state.pos.z) <
        ASSIST.sourceSpacingM
    )
      return null;
    const sx = source.state.pos.x - o.x,
      sz = source.state.pos.z - o.z;
    const angle = Math.acos(
      Math.max(
        -1,
        Math.min(
          1,
          ((x - o.x) * sx + (z - o.z) * sz) /
            (range * Math.max(1e-9, Math.hypot(sx, sz))),
        ),
      ),
    );
    if (angle < ASSIST.minimumAngleRad) return null;
    const world = this.map.world,
      y = world.heightAt(x, z) + DRONE.searchAgl;
    const pos = { x, y, z };
    if (!validMotion(world, pos, pos)) return null;
    const yaw = Math.atan2(o.x - x, o.z - z),
      pitch = Math.max(
        -1.5,
        Math.min(
          0.2,
          Math.atan2(world.heightAt(o.x, o.z) + DRONE.targetHeight - y, range),
        ),
      ),
      uncertainty =
        o.sigma + ASSIST.uncertaintyGrowthMps * Math.max(0, now - o.t);
    let visible = 0;
    for (const [dx, dz] of [
      [0, 0],
      [-uncertainty, 0],
      [uncertainty, 0],
      [0, -uncertainty],
      [0, uncertainty],
    ])
      for (const h of [0.65, 1.3]) {
        const q = {
          x: o.x + dx,
          z: o.z + dz,
          y: world.heightAt(o.x + dx, o.z + dz) + h,
        };
        const test = fovTest(pos, yaw, pitch, q);
        if (test.inRange && test.inFov && lineOfSight(world, pos, q) === "NONE")
          visible++;
      }
    return visible
      ? {
          x,
          z,
          support: visible / 10,
          angle,
          distance: Math.hypot(x - drone.state.pos.x, z - drone.state.pos.z),
        }
      : null;
  }
  private select(
    drone: Aircraft,
    source: Aircraft,
    cue: Evidence,
    now: number,
    old?: Active,
  ): {
    candidate: Candidate;
    waypoint: { x: number; z: number };
    distance: number;
  } | null {
    const retained =
      old?.status.goal &&
      this.candidate(
        old.status.goal.x,
        old.status.goal.z,
        drone,
        source,
        cue,
        now,
      );
    if (retained) {
      const path = this.planner.routes(drone.state.pos, [retained])[0];
      if (path)
        return {
          candidate: retained,
          waypoint: path.waypoint,
          distance: path.distance,
        };
    }
    const candidates = this.map.positions
      .filter((p) => !retained || p.x !== retained.x || p.z !== retained.z)
      .map((p) => this.candidate(p.x, p.z, drone, source, cue, now))
      .filter((p): p is Candidate => p !== null)
      .sort(
        (a, b) =>
          b.support - a.support ||
          a.distance - b.distance ||
          b.angle - a.angle ||
          a.x - b.x ||
          a.z - b.z,
      )
      .slice(0, ASSIST.routeShortlist - (retained ? 1 : 0));
    const paths = this.planner.routes(drone.state.pos, candidates);
    const routed = candidates.flatMap((candidate, i) =>
      paths[i]
        ? [
            {
              candidate,
              waypoint: paths[i]!.waypoint,
              distance: paths[i]!.distance,
            },
          ]
        : [],
    );
    routed.sort(
      (a, b) =>
        b.candidate.support - a.candidate.support ||
        a.distance - b.distance ||
        b.candidate.angle - a.candidate.angle ||
        a.candidate.x - b.candidate.x ||
        a.candidate.z - b.candidate.z,
    );
    return routed[0] ?? null;
  }
  update(
    now: number,
    drones: readonly Aircraft[],
    own: ReadonlyMap<SensorId, TrackerSnapshot>,
    accepted: readonly Evidence[],
  ): boolean {
    for (const e of accepted) if (e.observation) this.latest.set(e.sensorId, e);
    // Only the latest source cues its partner; ties use stable source ID, preventing reciprocal stale-cue pursuit.
    const cue = [...this.latest.values()]
      .filter((e) => now - e.sensedAt <= ASSIST.freshnessS)
      .sort(
        (a, b) =>
          b.sensedAt - a.sensedAt || a.sensorId.localeCompare(b.sensorId),
      )[0];
    let changed = false;
    for (const d of drones) {
      const old = this.active.get(d.id),
        local = own.get(d.id)!;
      const end = (state: AssistStatus["state"], reason: string) => {
        if (old) {
          this.active.delete(d.id);
          this.status.set(d.id, { ...old.status, state, reason });
          changed = true;
        }
      };
      if (hasRecentOwnFix(local)) {
        if (old) this.stats.confirmations++;
        end(
          "confirmed",
          "Own sensor confirmed the report; ordinary own-fix guidance has priority",
        );
        continue;
      }
      if (!cue || cue.sensorId === d.id) {
        if (old) this.stats.expired++;
        end("expired", "No fresh teammate report; ordinary search resumed");
        continue;
      }
      const source = drones.find((a) => a.id === cue.sensorId)!;
      if (old) {
        if (
          Math.hypot(
            d.state.pos.x - old.allocation.goal.x,
            d.state.pos.z - old.allocation.goal.z,
            d.state.pos.y -
              this.map.world.heightAt(
                old.allocation.goal.x,
                old.allocation.goal.z,
              ) -
              DRONE.searchAgl,
          ) <= ASSIST.arrivalM
        ) {
          old.arrivedAt ??= now;
          if (now - old.arrivedAt >= ASSIST.dwellS - 1e-8) {
            this.stats.dwellExpired++;
            end(
              "dwell-expired",
              "Viewpoint dwell ended without own confirmation; ordinary search resumed",
            );
            this.retryAt.set(d.id, now + ASSIST.cooldownS);
            continue;
          }
        } else old.arrivedAt = null;
      }
      if (now < (this.retryAt.get(d.id) ?? -Infinity)) continue;
      const o = cue.observation!;
      const invalidSpacing =
        old &&
        Math.hypot(
          old.allocation.goal.x - source.state.pos.x,
          old.allocation.goal.z - source.state.pos.z,
        ) < ASSIST.sourceSpacingM;
      const due =
        !old ||
        invalidSpacing ||
        now - old.refreshedAt >= ASSIST.refreshS - 1e-8 ||
        (now - old.refreshedAt >= ASSIST.minimumRefreshS - 1e-8 &&
          Math.hypot(o.x - old.anchor.x, o.z - old.anchor.z) >
            ASSIST.cueShiftM);
      if (!due) continue;
      const selected = this.select(d, source, cue, now, old);
      if (!selected) {
        this.stats.unavailable++;
        this.active.delete(d.id);
        this.status.set(d.id, {
          id: d.id,
          state: "unavailable",
          source: cue.sensorId,
          sensedAt: o.t,
          x: o.x,
          z: o.z,
          sigma: o.sigma,
          reason:
            "No reachable assist viewpoint found; ordinary search retained",
        });
        this.retryAt.set(d.id, now + ASSIST.refreshS);
        changed ||= !!old;
        continue;
      }
      const goal = { x: selected.candidate.x, z: selected.candidate.z };
      const status: AssistStatus = {
        id: d.id,
        state: "investigating",
        source: cue.sensorId,
        sensedAt: o.t,
        x: o.x,
        z: o.z,
        sigma: o.sigma,
        uncertaintyM:
          o.sigma + ASSIST.uncertaintyGrowthMps * Math.max(0, now - o.t),
        goal,
        sampledSupport: selected.candidate.support,
        reason: `Investigating Drone ${cue.sensorId}'s sighting; not confirmed by this drone`,
      };
      const allocation: Allocation = {
        id: d.id,
        goal,
        waypoint: { x: selected.waypoint.x, z: selected.waypoint.z },
        gaze: { x: o.x, z: o.z },
        mass: 0,
        routeMeters: selected.distance,
        overlap: null,
        score: 0,
        reason: status.reason,
      };
      this.active.set(d.id, {
        status,
        allocation,
        refreshedAt: now,
        anchor: { x: o.x, z: o.z },
        arrivedAt:
          old &&
          old.allocation.goal.x === goal.x &&
          old.allocation.goal.z === goal.z
            ? old.arrivedAt
            : null,
      });
      this.status.set(d.id, status);
      changed = true;
      if (old) this.stats.refreshes++;
      else this.stats.dispatches++;
    }
    return changed;
  }
  allocations(): Allocation[] {
    return [...this.active.values()].map((a) => a.allocation);
  }
  snapshot(): AssistStatus[] {
    return [...this.status.values()].map((s) => ({
      ...s,
      goal: s.goal ? { x: s.goal.x, z: s.goal.z } : undefined,
    }));
  }
}
