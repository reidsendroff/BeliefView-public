/** N3 public-only joint coverage and view tasking. No simulator subject or visibility verdict. */
import { DRONE } from "../sim/drone";
import type { TrackerSnapshot } from "../sim/types";
import { fovTest } from "../sim/sensor";
import { lineOfSight } from "../sim/geometry";
import { Navigation } from "../ml/navigation";
import { TeamMap } from "./map";
import { TeamBelief } from "./belief";
import {
  TeamPlanner,
  type Aircraft,
  type Allocation,
  type Ranked,
} from "./planner";
import { clearanceState } from "./clearance";
import { THREE } from "./threeConstants";
import type { SensorId, TeamArm } from "./types";
import type { ViewEstimate } from "./threeEstimate";
import { ThreeViews } from "./threeViews";
import { denseMask, unionMass, angularGaps } from "./threeUnion";
export interface ViewTask {
  id: SensorId;
  state: "moving" | "settling" | "holding" | "cooldown";
  estimate: ViewEstimate;
  goal: { x: number; z: number };
  gaze: { x: number; z: number };
  plannedBearingDeg: number;
  supportFraction: number;
  ownConfirmed: boolean;
  reason: string;
}
interface Candidate extends Ranked {
  mask: Uint16Array;
  support: number;
  task: boolean;
}
const pointKey = (p: { x: number; z: number }) =>
  Math.round(p.x / THREE.tabuCellM) + "," + Math.round(p.z / THREE.tabuCellM);
const pairGap = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
export class ThreePlanner {
  private base: TeamPlanner;
  private nav: Navigation;
  private views: ThreeViews;
  private tasks = new Map<SensorId, ViewTask>();
  private lastGoals = new Map<SensorId, { x: number; z: number }>();
  private arrivedWithoutFix = new Map<SensorId, number>();
  private cooldown = new Map<SensorId, number>();
  private tabu = new Map<string, number>();
  private tupleTabu = new Map<string, number>();
  private lastPlan = -Infinity;
  private lastCenter: { x: number; z: number } | null = null;
  private allocations: Allocation[] = [];
  readonly stats = {
    plans: 0,
    tuples: 0,
    routeFailures: 0,
    jointFallbacks: 0,
    taskDispatches: 0,
    taskExpiries: 0,
    slotRetries: 0,
    wallMs: 0,
  };
  constructor(private map: TeamMap) {
    this.base = new TeamPlanner(map);
    this.nav = new Navigation(map.world, map.geometry);
    this.views = new ThreeViews(map);
  }
  private recent(t: TrackerSnapshot) {
    return t.initialised && t.age <= THREE.ownRecentS;
  }
  private tupleKey(candidates: readonly Candidate[], ids: readonly SensorId[]) {
    return candidates.map((c, i) => ids[i] + ":" + pointKey(c.view)).join("|");
  }
  requestConflictReplan(now: number) {
    if (this.allocations.length === 3)
      this.tupleTabu.set(
        this.allocations
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((a) => a.id + ":" + pointKey(a.goal))
          .join("|"),
        now + THREE.tabuS,
      );
    this.lastPlan = -Infinity;
  }
  private diverse(
    ranks: Ranked[],
    center: { x: number; z: number },
    limit: number,
  ): Ranked[] {
    const buckets = new Map<number, Ranked>();
    for (const r of ranks) {
      const angle =
          (Math.atan2(r.view.z - center.z, r.view.x - center.x) + Math.PI * 2) %
          (Math.PI * 2),
        key = Math.floor((angle / (Math.PI * 2)) * 12);
      if (!buckets.has(key)) buckets.set(key, r);
    }
    const selected = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
      .slice(0, limit);
    for (const r of ranks)
      if (selected.length < limit && !selected.includes(r)) selected.push(r);
    return selected;
  }
  private ordinary(
    a: Aircraft,
    b: TeamBelief,
    arm: TeamArm,
    center: { x: number; z: number },
  ): Candidate[] {
    const index = ["A", "B", "C"].indexOf(a.id),
      sector = (p: { x: number; z: number }) => {
        const angle = (Math.atan2(p.z - 12, p.x) + Math.PI * 2) % (Math.PI * 2);
        return Math.floor(angle / ((Math.PI * 2) / 3)) === index;
      };
    const raw = this.base.candidates(
      a,
      b,
      arm === "sector" ? sector : undefined,
    );
    if (a.searching === false)
      return raw.map((r) => ({
        ...r,
        mask: denseMask(r.view, this.map.cells.length),
        support: 0,
        task: false,
      }));
    const selected = this.diverse(raw, center, THREE.candidateLimit),
      positions = selected.map((r) => ({ x: r.view.x, z: r.view.z }));
    const paths = this.nav.paths(a.state.pos, positions);
    return selected
      .flatMap((r, i) => {
        const path = paths[i];
        if (!path) {
          this.stats.routeFailures++;
          return [];
        }
        return [
          {
            ...r,
            distance: path.distance,
            waypoint: path.waypoint,
            score: r.mass / (1 + path.distance / 30),
            mask: denseMask(r.view, this.map.cells.length),
            support: 0,
            task: false,
          },
        ];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.distance - b.distance ||
          a.view.x - b.view.x ||
          a.view.z - b.view.z,
      );
  }
  private support(
    a: Aircraft,
    own: TrackerSnapshot,
    b: TeamBelief,
    e: ViewEstimate,
    now: number,
  ): Candidate[] {
    const w = this.map.world,
      gaze = this.recent(own) ? { x: own.x, z: own.z } : { x: e.x, z: e.z };
    const points: { x: number; z: number }[] = [];
    const previous = this.lastGoals.get(a.id);
    if (previous) points.push(previous);
    for (const radius of THREE.radiiM)
      for (let k = 0; k < THREE.bearings; k++) {
        const angle = (k * Math.PI * 2) / THREE.bearings;
        points.push({
          x:
            Math.round((e.x + radius * Math.sin(angle)) / THREE.supportGridM) *
            THREE.supportGridM,
          z:
            Math.round((e.z + radius * Math.cos(angle)) / THREE.supportGridM) *
            THREE.supportGridM,
        });
      }
    const unique = new Map<string, { x: number; z: number }>();
    for (const p of points) unique.set(p.x + "," + p.z, p);
    const candidates: {
      p: { x: number; z: number };
      support: number;
      distance: number;
    }[] = [];
    const radius = e.radius,
      offsets = [
        [0, 0],
        [radius, 0],
        [-radius, 0],
        [0, radius],
        [0, -radius],
      ];
    for (const p of unique.values()) {
      const range = pairGap(p, e);
      if (range < 10 - 1e-8 || range > 24 + 1e-8) continue;
      if ((this.tabu.get(a.id + ":" + pointKey(p)) ?? -Infinity) > now)
        continue;
      const pose = {
          x: p.x,
          z: p.z,
          y: w.heightAt(p.x, p.z) + DRONE.searchAgl,
        },
        clear = clearanceState(w, pose, 0, this.map.geometry);
      if (!clear.physicalValid || clear.totalDeficit > 1e-6) continue;
      const yaw = Math.atan2(gaze.x - p.x, gaze.z - p.z),
        pitch = Math.max(
          -1.5,
          Math.min(
            0.2,
            Math.atan2(
              w.heightAt(gaze.x, gaze.z) + DRONE.targetHeight - pose.y,
              pairGap(p, gaze),
            ),
          ),
        );
      let visible = 0;
      for (const [dx, dz] of offsets)
        for (const height of [0.65, 1.3]) {
          const q = {
              x: e.x + dx,
              z: e.z + dz,
              y: w.heightAt(e.x + dx, e.z + dz) + height,
            },
            f = fovTest(pose, yaw, pitch, q);
          if (
            f.inFov &&
            f.inRange &&
            (this.map.geometry
              ? this.map.geometry.lineOfSight(pose, q)
              : lineOfSight(w, pose, q)) === "NONE"
          )
            visible++;
        }
      if (visible)
        candidates.push({
          p,
          support: visible / 10,
          distance: pairGap(p, a.state.pos),
        });
    }
    candidates.sort(
      (a, b) =>
        b.support - a.support ||
        a.distance - b.distance ||
        a.p.x - b.p.x ||
        a.p.z - b.p.z,
    );
    // Route one strong candidate from each angular bucket, then fill the bounded shortlist.
    const buckets = new Map<number, (typeof candidates)[number]>();
    for (const c of candidates) {
      const angle =
          (Math.atan2(c.p.z - e.z, c.p.x - e.x) + Math.PI * 2) % (Math.PI * 2),
        key = Math.floor((angle / (Math.PI * 2)) * 12);
      if (!buckets.has(key)) buckets.set(key, c);
    }
    const shortlist = [...buckets.values()];
    const previousCandidate = previous
      ? candidates.find((c) => pairGap(c.p, previous) < 1e-6)
      : undefined;
    if (previousCandidate && !shortlist.includes(previousCandidate))
      shortlist.unshift(previousCandidate);
    for (const c of candidates)
      if (shortlist.length < THREE.routeLimit && !shortlist.includes(c))
        shortlist.push(c);
    shortlist.length = Math.min(shortlist.length, THREE.routeLimit);
    const paths = this.nav.paths(
      a.state.pos,
      shortlist.map((c) => c.p),
    );
    const routed: Candidate[] = [];
    for (let i = 0; i < shortlist.length; i++) {
      const c = shortlist[i],
        path = paths[i];
      if (!path) {
        this.stats.routeFailures++;
        continue;
      }
      const view = this.views.view(c.p.x, c.p.z, gaze),
        mask = denseMask(view, this.map.cells.length),
        mass = unionMass(b.probability, [mask]);
      routed.push({
        view,
        mask,
        mass,
        distance: path.distance,
        waypoint: path.waypoint,
        score: c.support / (1 + path.distance / 30),
        support: c.support,
        task: true,
      });
    }
    routed.sort(
      (a, b) =>
        b.score - a.score ||
        a.distance - b.distance ||
        a.view.x - b.view.x ||
        a.view.z - b.view.z,
    );
    const result = this.diverse(routed, e, THREE.candidateLimit) as Candidate[];
    const old = previous
      ? routed.find((c) => pairGap(c.view, previous) < 1e-6)
      : undefined;
    if (old && !result.includes(old)) {
      if (result.length >= THREE.candidateLimit) result.pop();
      result.push(old);
    }
    return result;
  }
  update(
    now: number,
    drones: readonly Aircraft[],
    beliefs: ReadonlyMap<SensorId, TeamBelief>,
    own: ReadonlyMap<SensorId, TrackerSnapshot>,
    arm: TeamArm,
    estimate: ViewEstimate | null,
  ): boolean {
    let urgent = Boolean(estimate && !this.lastCenter);
    const retryIds = new Set<SensorId>();
    for (const d of drones) {
      const task = this.tasks.get(d.id);
      if (!task) continue;
      const track = own.get(d.id)!;
      if (arm === "shared" && this.recent(track)) {
        this.tasks.delete(d.id);
        this.arrivedWithoutFix.delete(d.id);
        urgent = true;
        continue;
      }
      if (!estimate) {
        this.tasks.delete(d.id);
        this.arrivedWithoutFix.delete(d.id);
        this.stats.taskExpiries++;
        urgent = true;
        continue;
      }
      const arrived =
        Math.hypot(
          d.state.pos.x - task.goal.x,
          d.state.pos.z - task.goal.z,
          d.state.pos.y -
            this.map.world.heightAt(task.goal.x, task.goal.z) -
            DRONE.searchAgl,
        ) <= THREE.arrivalM;
      if (arrived && !this.recent(track)) {
        const since = this.arrivedWithoutFix.get(d.id) ?? now;
        this.arrivedWithoutFix.set(d.id, since);
        if (now - since >= THREE.unconfirmedDwellS - 1e-8) {
          this.tabu.set(d.id + ":" + pointKey(task.goal), now + THREE.tabuS);
          retryIds.add(d.id);
          this.tasks.delete(d.id);
          this.arrivedWithoutFix.delete(d.id);
          this.stats.slotRetries++;
          urgent = true;
        }
      } else this.arrivedWithoutFix.delete(d.id);
    }
    const shift =
      estimate && this.lastCenter
        ? pairGap(estimate, this.lastCenter)
        : Infinity;
    if (
      !urgent &&
      now - this.lastPlan < THREE.refreshS - 1e-8 &&
      !(
        estimate &&
        now - this.lastPlan >= THREE.earlyRefreshS - 1e-8 &&
        shift > THREE.cueShiftM
      )
    )
      return false;
    const started = performance.now();
    this.lastPlan = now;
    this.stats.plans++;
    try {
      const sorted = [...drones].sort((a, b) => a.id.localeCompare(b.id)),
        ids = sorted.map((d) => d.id);
      const center = estimate ?? { x: 0, z: 12 };
      const shared = arm === "shared" || arm === "coordinated";
      const ranks = sorted.map((d) => {
        const taskable =
          shared &&
          estimate &&
          (this.cooldown.get(d.id) ?? -Infinity) <= now &&
          (arm === "coordinated" || !this.recent(own.get(d.id)!));
        const support = taskable
          ? this.support(d, own.get(d.id)!, beliefs.get(d.id)!, estimate, now)
          : [];
        if (retryIds.has(d.id) && !support.length)
          this.cooldown.set(d.id, now + THREE.cooldownS);
        const ordinary = support.length
          ? []
          : this.ordinary(d, beliefs.get(d.id)!, arm, center);
        return support.length
          ? support
          : (this.cooldown.get(d.id) ?? -Infinity) > now
            ? ordinary.slice(0, 1)
            : ordinary;
      });
      let selected: (Candidate | null)[] = ranks.map((r) => r[0] ?? null);
      let joint = false,
        best = -Infinity;
      let previous: Candidate[] | null = null,
        previousScore = -Infinity;
      const score = (cs: Candidate[]) => {
        const p = beliefs.get(ids[0])!.probability,
          coverage = unionMass(
            p,
            cs.map((c) => c.mask),
          );
        const gaps = angularGaps(
            cs.filter((c) => c.task).map((c) => c.view),
            center,
          ),
          angle =
            arm === "coordinated" && estimate && gaps.length > 1
              ? Math.min(1, Math.min(...gaps) / 120)
              : 0;
        const retention =
          cs.reduce(
            (s, c, i) =>
              s +
              Number(
                this.lastGoals.has(ids[i]) &&
                  pairGap(c.view, this.lastGoals.get(ids[i])!) < 1e-6,
              ),
            0,
          ) / 3;
        return (
          coverage -
          (THREE.routePenalty * cs.reduce((s, c) => s + c.distance / 60, 0)) /
            3 +
          THREE.angleReward * angle +
          THREE.retentionBonus * retention
        );
      };
      if (shared && ranks.every((r) => r.length)) {
        for (const a of ranks[0])
          for (const b of ranks[1])
            for (const c of ranks[2]) {
              this.stats.tuples++;
              const cs = [a, b, c];
              if (
                pairGap(a.view, b.view) < THREE.goalSeparationM ||
                pairGap(a.view, c.view) < THREE.goalSeparationM ||
                pairGap(b.view, c.view) < THREE.goalSeparationM
              )
                continue;
              if (
                (this.tupleTabu.get(this.tupleKey(cs, ids)) ?? -Infinity) > now
              )
                continue;
              const value = score(cs);
              if (value > best + 1e-12) {
                best = value;
                selected = cs;
                joint = true;
              }
              if (
                cs.every(
                  (r, i) =>
                    this.lastGoals.has(ids[i]) &&
                    pairGap(r.view, this.lastGoals.get(ids[i])!) < 1e-6,
                )
              ) {
                previous = cs;
                previousScore = value;
              }
            }
        if (previous && best < previousScore + THREE.improvement) {
          selected = previous;
          best = previousScore;
          joint = true;
        }
      }
      if (shared && !joint) {
        this.stats.jointFallbacks++;
        for (const id of retryIds) this.cooldown.set(id, now + THREE.cooldownS);
        selected = sorted.map(
          (d) => this.ordinary(d, beliefs.get(d.id)!, arm, center)[0] ?? null,
        );
      }
      this.tasks.clear();
      this.allocations = [];
      for (let i = 0; i < 3; i++) {
        const c = selected[i];
        if (!c) continue;
        const id = ids[i],
          goal = { x: c.view.x, z: c.view.z };
        const oldGoal = this.lastGoals.get(id);
        if (!oldGoal || pairGap(oldGoal, goal) > 1e-6)
          this.arrivedWithoutFix.delete(id);
        this.lastGoals.set(id, goal);
        if (c.task && estimate && joint) {
          this.tasks.set(id, {
            id,
            state: "moving",
            estimate,
            goal,
            gaze: c.view.gaze,
            plannedBearingDeg:
              (Math.atan2(goal.z - estimate.z, goal.x - estimate.x) * 180) /
              Math.PI,
            supportFraction: c.support,
            ownConfirmed: this.recent(own.get(id)!),
            reason:
              arm === "coordinated"
                ? "Joint complementary view around accepted report estimate"
                : "Jointly spaced teammate-sighting investigation",
          });
          this.stats.taskDispatches++;
        }
        this.allocations.push({
          id,
          goal,
          waypoint: c.waypoint,
          gaze: c.view.gaze,
          mass: c.mass,
          routeMeters: c.distance,
          overlap: null,
          score: joint ? best : c.score,
          reason: c.task
            ? "Joint report-based view task"
            : joint
              ? "Exact three-view model-mass union with separate route cost"
              : arm === "sector"
                ? "Own evidence within fixed public third-sector"
                : "Own expected visible model mass",
        });
      }
      for (const id of ids)
        if (!this.tasks.has(id)) this.arrivedWithoutFix.delete(id);
      this.lastCenter = estimate ? { x: estimate.x, z: estimate.z } : null;
      return true;
    } finally {
      this.stats.wallMs += performance.now() - started;
    }
  }
  getAllocations() {
    return this.allocations;
  }
  getTask(id: SensorId) {
    return this.tasks.get(id);
  }
  snapshot() {
    return [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  get cachedViewPositions() {
    return this.views.cachedPositions;
  }
}
