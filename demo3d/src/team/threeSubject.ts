/** N3 scripted goal/route/cover policy. Only own state, static map and degraded per-ID drone positions. */
import { SUBJECT, type SubjectSnapshot } from "../sim/subject";
import type { Vec3 } from "../sim/types";
import type { SensorId } from "./types";
import {
  bodyPose,
  BODY_VERSION,
  type BodyInput,
  type Posture,
  type PostureTransition,
} from "./threeBody";
import {
  ThreeGeometry,
  type ThreeWorld,
  type N3CoverObject,
} from "./threeGeometry";
import {
  ThreeGroundNavigation,
  type GroundPoint,
} from "./threeGroundNavigation";
import { ThreePerception, type ThreatCue } from "./threePerception";
export const SUBJECT_VERSION = "n3-purposeful-cover-v1";
export type ThreeBehavior =
  | "travel"
  | "approach-cover"
  | "lowering"
  | "holding-cover"
  | "repositioning"
  | "route-blocked";
export interface ThreeSubjectSnapshot extends SubjectSnapshot {
  subjectVersion: typeof SUBJECT_VERSION;
  bodyVersion: typeof BODY_VERSION;
  body: BodyInput;
  behavior: ThreeBehavior;
  coverObjectId: string | null;
  perceivedThreats: ThreatCue[];
  coverScore: number;
  routeRemainingM: number;
  routeReason: string;
  intentionalHold: boolean;
  routeProgressTotalM: number;
}
interface CoverChoice {
  object: N3CoverObject;
  point: GroundPoint;
  approach: GroundPoint;
  heading: number;
  posture: Posture;
  score: number;
  fully: number;
  path: GroundPoint[];
  distance: number;
}
const diff = (a: number, b: number) =>
  Math.atan2(Math.sin(b - a), Math.cos(b - a));
const distance = (a: GroundPoint, b: GroundPoint) =>
  Math.hypot(a.x - b.x, a.z - b.z);
export class ThreeSubjectAgent {
  private geometry: ThreeGeometry;
  private nav: ThreeGroundNavigation;
  private perception: ThreePerception;
  private x: number;
  private z: number;
  private heading = 0;
  private speed = 0;
  private gait = 0;
  private turnRate = 0;
  private time = 0;
  private poseStationaryS = 0;
  private escapingPose = false;
  private routeProgressTotal = 0;
  private posture: PostureTransition = {
    from: "standing",
    to: "standing",
    progress: 1,
  };
  private behavior: ThreeBehavior = "travel";
  private cues: ThreatCue[] = [];
  private selected: CoverChoice | null = null;
  private path: GroundPoint[] = [];
  private goalIndex = 1;
  private nextReview = 0;
  private nextSearch = 0;
  private noCueSince = 0;
  private bestRemaining = Infinity;
  private progressAt = 0;
  private routeReason = "Following a reachable destination";
  private visits: { x: number; z: number; t: number }[] = [];
  private tabu = new Map<string, number>();
  private failed = new Map<string, number>();
  readonly stats = {
    coverPlans: 0,
    candidates: 0,
    bodyRays: 0,
    reachedCover: 0,
    rejectedTransitions: 0,
    routeFailures: 0,
    replans: 0,
    loopWindows: 0,
    maxLoopRunS: 0,
    wallMs: 0,
    rejections: {} as Record<string, number>,
  };
  constructor(
    readonly world: ThreeWorld,
    private goals: readonly (readonly [number, number])[],
    seed: number,
  ) {
    if (goals.length < 2) throw Error("Subject requires valid destinations");
    this.x = goals[0][0];
    this.z = goals[0][1];
    this.geometry = new ThreeGeometry(world);
    this.nav = new ThreeGroundNavigation(this.geometry);
    this.perception = new ThreePerception(seed);
    this.heading = Math.atan2(goals[1][0] - this.x, goals[1][1] - this.z);
  }
  private input(
    x = this.x,
    z = this.z,
    heading = this.heading,
    posture = this.posture,
    gait = this.gait,
  ): BodyInput {
    return {
      root: { x, y: this.world.heightAt(x, z), z },
      heading,
      gait,
      speed: this.speed,
      posture: {
        from: posture.from,
        to: posture.to,
        progress: posture.progress,
      },
    };
  }
  snapshot(): ThreeSubjectSnapshot {
    return {
      x: this.x,
      z: this.z,
      y: this.world.heightAt(this.x, this.z),
      heading: this.heading,
      speed: this.speed,
      gait: this.gait,
      turnRate: this.turnRate,
      crouch:
        this.posture.to === "standing"
          ? 1 - this.posture.progress
          : this.posture.progress,
      action:
        this.behavior === "holding-cover"
          ? "HIDE"
          : this.selected
            ? "SEEK_COVER"
            : "TRAVEL",
      cover: -1,
      percept: null,
      subjectVersion: SUBJECT_VERSION,
      bodyVersion: BODY_VERSION,
      body: this.input(),
      behavior: this.behavior,
      coverObjectId: this.selected?.object.id ?? null,
      perceivedThreats: this.cues.map((c) => ({
        id: c.id,
        sensedAt: c.sensedAt,
        position: { x: c.position.x, y: c.position.y, z: c.position.z },
      })),
      coverScore: this.selected?.score ?? 0,
      routeRemainingM: this.remaining(),
      routeReason: this.routeReason,
      intentionalHold: this.behavior === "holding-cover",
      routeProgressTotalM: this.routeProgressTotal,
    };
  }
  private point(): GroundPoint {
    return { x: this.x, z: this.z };
  }
  private remaining() {
    let sum = 0,
      p: GroundPoint = { x: this.x, z: this.z };
    for (const q of this.path) {
      sum += distance(p, q);
      p = q;
    }
    return sum;
  }
  private swept(input: BodyInput, old = this.input(), recordRejection = true) {
    const initialProgress =
        old.posture.from === input.posture.from &&
        old.posture.to === input.posture.to
          ? old.posture.progress
          : 0,
      n = Math.max(
        1,
        Math.ceil(distance(old.root, input.root) / 0.05),
        Math.ceil(
          Math.abs(diff(old.heading, input.heading)) / ((5 * Math.PI) / 180),
        ),
        Math.ceil(Math.abs(input.posture.progress - initialProgress) / 0.05),
      );
    for (let i = 1; i <= n; i++) {
      const t = i / n,
        pose: BodyInput = {
          root: {
            x: old.root.x + (input.root.x - old.root.x) * t,
            y: 0,
            z: old.root.z + (input.root.z - old.root.z) * t,
          },
          heading: old.heading + diff(old.heading, input.heading) * t,
          gait: old.gait + (input.gait - old.gait) * t,
          speed: input.speed,
          posture: {
            from: input.posture.from,
            to: input.posture.to,
            progress:
              initialProgress + (input.posture.progress - initialProgress) * t,
          },
        };
      pose.root.y = this.world.heightAt(pose.root.x, pose.root.z);
      const rejected = this.geometry.bodyFailure(
        bodyPose(pose, this.world),
        0.03,
      );
      if (rejected) {
        if (recordRejection)
          this.stats.rejections[rejected] =
            (this.stats.rejections[rejected] ?? 0) + 1;
        return false;
      }
    }
    return true;
  }
  private score(
    point: GroundPoint,
    heading: number,
    posture: Posture,
    object?: N3CoverObject,
    full = true,
  ) {
    const pose = bodyPose(
      this.input(point.x, point.z, heading, {
        from: posture,
        to: posture,
        progress: 1,
      }),
      this.world,
    );
    if (!this.geometry.bodyValid(pose)) return null;
    const samples = full ? pose.samples : [pose.samples[0], pose.samples[2]],
      fractions: number[] = [];
    let attributed = !object;
    for (const c of this.cues) {
      const dx = point.x - c.position.x,
        dz = point.z - c.position.z,
        n = Math.hypot(dx, dz) || 1;
      let worst = 1;
      for (const shift of full ? [-1.5, 0, 1.5] : [0]) {
        const from = {
          x: c.position.x - (dz / n) * shift,
          y: c.position.y,
          z: c.position.z + (dx / n) * shift,
        };
        let blocked = 0;
        for (const sample of samples) {
          this.stats.bodyRays++;
          if (this.geometry.lineOfSight(from, sample.point) !== "NONE")
            blocked++;
          if (
            object &&
            shift === 0 &&
            this.geometry.objectBlocks(object, from, sample.point)
          )
            attributed = true;
        }
        worst = Math.min(worst, blocked / samples.length);
      }
      fractions.push(worst);
    }
    return attributed && fractions.length
      ? {
          score: Math.min(...fractions),
          fully: fractions.filter((f) => f === 1).length,
        }
      : null;
  }
  private coverConnector(
    approach: GroundPoint,
    point: GroundPoint,
    heading: number,
    posture: Posture,
  ) {
    let old = this.input(
      approach.x,
      approach.z,
      heading,
      { from: "standing", to: "standing", progress: 1 },
      0,
    );
    old.speed = 0;
    if (!this.geometry.bodyValid(bodyPose(old, this.world))) return false;
    for (const to of posture === "prone"
      ? (["kneeling", "prone"] as const)
      : [posture]) {
      const next = {
        ...old,
        posture: { from: old.posture.to, to, progress: 1 },
      };
      if (!this.swept(next, old, false)) return false;
      old = next;
    }
    const end = {
      ...old,
      root: {
        x: point.x,
        y: this.world.heightAt(point.x, point.z),
        z: point.z,
      },
    };
    return this.swept(end, old, false);
  }
  private reconnectEnvelope() {
    for (const radius of [0.5, 1, 1.5, 2, 3])
      for (let k = 0; k < 16; k++) {
        const p = {
          x: this.x + Math.sin((k * Math.PI) / 8) * radius,
          z: this.z + Math.cos((k * Math.PI) / 8) * radius,
        };
        if (
          this.nav.free(p.x, p.z) &&
          this.swept(this.input(p.x, p.z), this.input(), false)
        ) {
          this.path = [p];
          this.escapingPose = true;
          this.behavior = "repositioning";
          this.routeReason = "Body-valid connection to the ground route";
          this.bestRemaining = distance(this.point(), p);
          this.progressAt = this.time;
          return true;
        }
      }
    return false;
  }
  private chooseCover() {
    const started = performance.now();
    this.stats.coverPlans++;
    const current =
      this.score({ x: this.x, z: this.z }, this.heading, this.posture.to)
        ?.score ?? 0;
    const nearbyObjects = this.world.n3Covers
      .filter(
        (o) =>
          distance(o, { x: this.x, z: this.z }) <= 30 &&
          (this.tabu.get(o.id) ?? 0) <= this.time,
      )
      .sort(
        (a, b) =>
          distance(a, this.point()) - distance(b, this.point()) ||
          a.id.localeCompare(b.id),
      );
    const buckets = ["tree", "boulder", "log", "bush", "leaf-pile"].map(
      (kind) => nearbyObjects.filter((o) => o.kind === kind),
    );
    const objects: N3CoverObject[] = [];
    for (
      let rank = 0;
      objects.length < 16 && buckets.some((b) => rank < b.length);
      rank++
    )
      for (const bucket of buckets)
        if (bucket[rank] && objects.length < 16) objects.push(bucket[rank]);
    const candidates: Omit<CoverChoice, "path" | "distance">[] = [];
    let attempted = 0;
    for (const object of objects) {
      let objectAttempts = 0;
      const tried = new Set<string>();
      const bearings: number[] = [];
      for (const c of this.cues)
        bearings.push(
          Math.atan2(object.x - c.position.x, object.z - c.position.z),
        );
      for (let k = 0; k < 8; k++) bearings.push((k * Math.PI) / 4);
      for (const bearing of bearings) {
        for (const posture of object.kind === "log"
          ? ["prone" as const]
          : ["crouched" as const, "prone" as const]) {
          if (attempted >= 96 || objectAttempts >= 6) break;
          let point: GroundPoint, heading: number;
          if (object.kind === "log") {
            const nx = Math.cos(object.yaw),
              nz = -Math.sin(object.yaw),
              sign =
                Math.sin(bearing) * nx + Math.cos(bearing) * nz >= 0 ? 1 : -1;
            point = {
              x: object.x + nx * sign * (object.radius + 0.48),
              z: object.z + nz * sign * (object.radius + 0.48),
            };
            heading = object.yaw;
            if (object.length < 2.2) continue;
          } else {
            point = {
              x: object.x + Math.sin(bearing) * (object.radius + 0.55),
              z: object.z + Math.cos(bearing) * (object.radius + 0.55),
            };
            heading = bearing + Math.PI / 2;
          }
          const key = [posture, point.x.toFixed(2), point.z.toFixed(2)].join(
            ":",
          );
          if (tried.has(key)) continue;
          tried.add(key);
          objectAttempts++;
          attempted++;
          this.stats.candidates++;
          const scored = this.score(point, heading, posture, object, false);
          if (!scored || scored.score < 0.5 || scored.score < current + 0.1)
            continue;
          let approach = point;
          if (!this.nav.free(point.x, point.z)) {
            const alternatives = [1, 1.5, 2].flatMap((r) =>
              Array.from({ length: 8 }, (_, k) => ({
                x: point.x + Math.sin((k * Math.PI) / 4) * r,
                z: point.z + Math.cos((k * Math.PI) / 4) * r,
              })),
            );
            const free = alternatives.find((p) => this.nav.free(p.x, p.z));
            if (!free) continue;
            approach = free;
          }
          candidates.push({
            object,
            point,
            approach,
            heading,
            posture,
            ...scored,
          });
        }
      }
    }
    const visitPenalty = (p: GroundPoint) =>
      this.visits.some((v) => this.time - v.t < 12 && distance(v, p) < 1)
        ? 0.2
        : 0;
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        b.fully - a.fully ||
        distance(a.approach, this.point()) +
          visitPenalty(a.point) * 10 -
          distance(b.approach, this.point()) -
          visitPenalty(b.point) * 10 ||
        a.object.id.localeCompare(b.object.id),
    );
    const finalists = candidates.slice(0, 12),
      routes = this.nav.routes(
        this.point(),
        finalists.map((c) => c.approach),
      );
    let best: CoverChoice | null = null;
    for (let i = 0; i < finalists.length; i++) {
      const c = finalists[i],
        route = routes[i];
      if (!route) continue;
      const s = this.score(c.point, c.heading, c.posture, c.object, true);
      if (!s || s.score < 0.5 || s.score < current + 0.1) continue;
      if (!this.coverConnector(c.approach, c.point, c.heading, c.posture))
        continue;
      const choice = {
        ...c,
        ...s,
        path: route.path.slice(1),
        distance: route.distance,
      };
      if (
        !best ||
        choice.score > best.score + 1e-9 ||
        (choice.score === best.score &&
          (choice.fully > best.fully ||
            (choice.fully === best.fully && choice.distance < best.distance)))
      )
        best = choice;
    }
    this.stats.wallMs += performance.now() - started;
    if (best) {
      this.selected = best;
      this.path = best.path;
      this.behavior = "approach-cover";
      this.routeReason =
        "Reachable cover between body and degraded threat cues";
      this.bestRemaining = this.remaining();
      this.progressAt = this.time;
      this.stats.replans++;
    }
    return !!best;
  }
  private travel() {
    if (!this.nav.free(this.x, this.z) && this.reconnectEnvelope()) return;
    for (let attempt = 0; attempt < this.goals.length; attempt++) {
      const goal = {
        x: this.goals[this.goalIndex][0],
        z: this.goals[this.goalIndex][1],
      };
      if (distance(this.point(), goal) < 3) {
        this.goalIndex = (this.goalIndex + 1) % this.goals.length;
        continue;
      }
      const d = distance(this.point(), goal),
        local =
          d > 28
            ? {
                x: this.x + ((goal.x - this.x) * 28) / d,
                z: this.z + ((goal.z - this.z) * 28) / d,
              }
            : goal,
        route = this.nav.routes(this.point(), [local])[0];
      if (route) {
        this.path = route.path.slice(1);
        this.bestRemaining = this.remaining();
        this.progressAt = this.time;
        this.behavior = "travel";
        return;
      }
      this.goalIndex = (this.goalIndex + 1) % this.goals.length;
    }
    this.stats.routeFailures++;
    this.behavior = "route-blocked";
    this.routeReason = "No reachable local destination found";
  }
  private abandon(reason: string) {
    if (this.selected) {
      this.tabu.set(this.selected.object.id, this.time + 8);
      this.failed.set(
        this.selected.object.id,
        (this.failed.get(this.selected.object.id) ?? 0) + 1,
      );
    }
    this.selected = null;
    this.path = [];
    this.behavior = "repositioning";
    this.routeReason = reason;
    this.nextSearch = Math.max(this.nextSearch, this.time);
  }
  private transition(to: Posture, dt: number) {
    if (this.posture.to !== to) {
      if (this.posture.progress < 1) {
        this.transition(this.posture.to, dt);
        return false;
      }
      this.posture = { from: this.posture.to, to, progress: 0 };
    }
    if (this.posture.progress >= 1) return true;
    const duration =
        this.posture.from === "prone" || to === "prone" ? 0.8 : 0.65,
      next = {
        ...this.posture,
        progress: Math.min(1, this.posture.progress + dt / duration),
      },
      input = this.input(this.x, this.z, this.heading, next);
    if (!this.swept(input)) {
      this.stats.rejectedTransitions++;
      return false;
    }
    this.posture = next;
    return next.progress >= 1;
  }
  step(positions: readonly { id: SensorId; position: Vec3 }[], dt: number) {
    const before = {
      x: this.x,
      z: this.z,
      heading: this.heading,
      posture: { ...this.posture },
    };
    this.advance(positions, dt);
    const changed =
      distance(before, this.point()) > 1e-5 ||
      Math.abs(diff(before.heading, this.heading)) > 1e-4 ||
      (this.posture.progress > 1e-4 &&
        (this.posture.from !== before.posture.from ||
          this.posture.to !== before.posture.to ||
          this.posture.progress > before.posture.progress + 1e-4));
    const attempted =
      this.behavior !== "holding-cover" &&
      (this.behavior === "route-blocked" ||
        this.path.length > 0 ||
        this.selected !== null ||
        this.posture.to !== "standing" ||
        this.posture.progress < 1);
    this.poseStationaryS =
      attempted && !changed ? this.poseStationaryS + dt : 0;
    if (this.poseStationaryS >= 3 - 1e-9) {
      this.abandon("Body turn/posture made no progress for3s");
      this.poseStationaryS = 0;
      let escape: GroundPoint | null = null;
      for (const r of [0.5, 1, 2, 3]) {
        for (let k = 0; k < 16; k++) {
          const p = {
            x: this.x + Math.sin((k * Math.PI) / 8) * r,
            z: this.z + Math.cos((k * Math.PI) / 8) * r,
          };
          if (this.nav.free(p.x, p.z) && this.swept(this.input(p.x, p.z))) {
            escape = p;
            break;
          }
        }
        if (escape) break;
      }
      if (escape) {
        this.path = [escape];
        this.escapingPose = true;
        this.behavior = "repositioning";
        this.bestRemaining = distance(this.point(), escape);
        this.progressAt = this.time;
      } else {
        this.behavior = "route-blocked";
        this.routeReason = "No collision-free posture recovery found";
      }
    }
  }
  private advance(
    positions: readonly { id: SensorId; position: Vec3 }[],
    dt: number,
  ) {
    this.time += dt;
    this.cues = this.perception.observe(positions, this.point(), this.time);
    if (this.cues.length) this.noCueSince = this.time;
    this.visits.push({ x: this.x, z: this.z, t: this.time });
    while (this.visits.length && this.time - this.visits[0].t > 20)
      this.visits.shift();
    if (this.time >= this.nextReview) {
      this.nextReview = this.time + 0.5;
      if (this.selected) {
        const s = this.score(
          this.selected.point,
          this.selected.heading,
          this.selected.posture,
          this.selected.object,
        );
        if (
          (this.cues.length && (!s || s.score < this.selected.score - 0.15)) ||
          (!this.cues.length && this.time - this.noCueSince > 8)
        )
          this.abandon("Perceived cover no longer useful");
      }
      if (
        !this.selected &&
        !this.escapingPose &&
        this.cues.length &&
        this.time >= this.nextSearch
      ) {
        this.nextSearch = this.time + 2;
        this.chooseCover();
      }
    }
    if (
      this.selected &&
      this.behavior !== "holding-cover" &&
      distance(this.point(), this.selected.approach) < 0.35 &&
      !this.path.length
    ) {
      const angle = diff(this.heading, this.selected.heading),
        turn = Math.max(
          -SUBJECT.maxTurnRate * dt,
          Math.min(SUBJECT.maxTurnRate * dt, angle),
        );
      if (Math.abs(angle) > 0.05) {
        const q = this.input(this.x, this.z, this.heading + turn);
        if (this.swept(q)) this.heading += turn;
        this.speed = 0;
        return;
      }
      this.speed = 0;
      this.behavior = "lowering";
      const desired = this.selected.posture;
      if (this.posture.to === "standing" && desired === "prone") {
        this.transition("kneeling", dt);
        return;
      }
      if (!this.transition(desired, dt)) return;
      if (distance(this.point(), this.selected.point) > 0.1) {
        this.path = [this.selected.point];
        this.behavior = "approach-cover";
      } else {
        this.stats.reachedCover++;
        this.behavior = "holding-cover";
        this.routeReason =
          "Holding while degraded cues still indicate useful cover";
        return;
      }
    }
    if (this.behavior === "holding-cover") {
      this.speed = 0;
      return;
    }
    if (
      !this.selected &&
      !this.escapingPose &&
      (this.posture.to !== "standing" || this.posture.progress < 1)
    ) {
      this.speed = 0;
      if (!this.transition("standing", dt)) return;
    }
    if (!this.path.length) {
      if (this.escapingPose) {
        this.escapingPose = false;
        this.speed = 0;
        return;
      }
      if (this.selected && distance(this.point(), this.selected.point) < 0.2) {
        this.stats.reachedCover++;
        this.behavior = "holding-cover";
        this.routeReason =
          "Holding while degraded cues still indicate useful cover";
        this.speed = 0;
        return;
      }
      this.travel();
    }
    while (this.path.length) {
      const finalCover =
        this.selected &&
        this.path.length === 1 &&
        distance(this.path[0], this.selected.point) < 1e-6;
      if (
        (this.escapingPose && !this.nav.free(this.x, this.z)) ||
        distance(this.point(), this.path[0]) >=
          (this.escapingPose ? 0.03 : finalCover ? 0.1 : 0.25)
      )
        break;
      this.path.shift();
    }
    if (!this.path.length) {
      this.speed = 0;
      return;
    }
    const fixedHeadingTransit =
      this.escapingPose ||
      (!!this.selected &&
        this.posture.to === this.selected.posture &&
        this.posture.progress === 1 &&
        this.path.length === 1 &&
        distance(this.path[0], this.selected.point) < 1e-6);
    const goal = this.path[0],
      d = distance(this.point(), goal),
      desired = fixedHeadingTransit
        ? this.heading
        : Math.atan2(goal.x - this.x, goal.z - this.z),
      angle = diff(this.heading, desired),
      turn = Math.max(
        -SUBJECT.maxTurnRate * dt,
        Math.min(SUBJECT.maxTurnRate * dt, angle),
      );
    this.turnRate = turn / dt;
    const heading = this.heading + turn;
    const cap =
        this.posture.to === "prone"
          ? 0.7
          : this.escapingPose
            ? SUBJECT.creepSpeed
            : this.posture.to === "standing"
              ? this.selected
                ? SUBJECT.sprintMin
                : SUBJECT.jogSpeed
              : SUBJECT.creepSpeed,
      target =
        Math.abs(angle) > 0.6
          ? 0
          : Math.min(cap, Math.sqrt(2 * SUBJECT.decel * d)),
      speed = Math.max(
        0,
        this.speed +
          Math.max(
            -SUBJECT.decel * dt,
            Math.min(SUBJECT.accel * dt, target - this.speed),
          ),
      ),
      move = Math.min(d, speed * dt),
      x =
        this.x +
        (fixedHeadingTransit ? (goal.x - this.x) / d : Math.sin(heading)) *
          move,
      z =
        this.z +
        (fixedHeadingTransit ? (goal.z - this.z) / d : Math.cos(heading)) *
          move,
      input = this.input(x, z, heading, this.posture, this.gait + move);
    input.speed = speed;
    if (this.swept(input)) {
      this.x = x;
      this.z = z;
      this.heading = heading;
      this.speed = speed;
      this.gait += move;
    } else {
      this.speed = 0;
      this.stats.routeFailures++;
      this.path = [];
      if (this.selected) this.abandon("Body route segment obstructed");
      this.nextSearch = Math.max(this.nextSearch, this.time);
      this.routeReason = "Body route segment obstructed";
      this.bestRemaining = Infinity;
      this.progressAt = this.time;
      return;
    }
    const remaining = this.remaining();
    if (remaining < this.bestRemaining - 0.5) {
      if (Number.isFinite(this.bestRemaining))
        this.routeProgressTotal += this.bestRemaining - remaining;
      this.bestRemaining = remaining;
      this.progressAt = this.time;
    } else if (this.time - this.progressAt >= 3 && this.path.length) {
      this.abandon("Route made no new progress for3s");
      this.progressAt = this.time;
    }
  }
}
