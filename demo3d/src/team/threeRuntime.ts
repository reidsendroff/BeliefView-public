/** Simulation/evaluation orchestrator. Hidden state stays here, never in ledger/filter/planner inputs. */
import { type DroneState, type SearchGuidance } from "../sim/drone";
import { Tracker } from "../sim/tracker";

import type { Observation, TrackerSnapshot } from "../sim/types";
import { inWater } from "../sim/richWorld";
import { hasRecentOwnFix } from "./assist";
import { ThreeEstimate } from "./threeEstimate";
import { ThreePlanner, type ViewTask } from "./threePlanner";
import {
  ThreeMotion,
  allPairSweeps,
  type ThreeMotionOptions,
} from "./threeMotion";
import { threeNoise, initialThreeDrones } from "./threeScenario";
import { ThreeGeometry, type ThreeWorld } from "./threeGeometry";
import {
  ThreeSubjectAgent,
  type ThreeSubjectSnapshot,
  SUBJECT_VERSION,
} from "./threeSubject";
import { bodyPose, BODY_VERSION } from "./threeBody";
import { bodyDetection, SENSOR_VERSION } from "./threeSensing";
import { createThreeController } from "./threeDrone";
import { THREE_VERSION } from "./threeConstants";
import { TeamRecovery, type RecoveryStatus } from "./recovery";
import { physicalMotion, clearanceState } from "./clearance";

import { TeamMap } from "./map";
import { TeamBelief } from "./belief";
import { type Aircraft, type Allocation } from "./planner";
import { type TeamScenario } from "./scenario";

import {
  TEAM,
  THREE_IDS,
  type Evidence,
  type SensorId,
  type TeamArm,
} from "./types";
export interface ThreeFrame {
  i: number;
  t: number;
  subject: ThreeSubjectSnapshot;
  subjectExposure: {
    id: SensorId;
    visibleSamples: number;
    geometricallyBlockedSamples: number;
    inFrameSamples: number;
    bodyValid: boolean;
  }[];
  aircraft: {
    id: SensorId;
    state: DroneState;
    observation: Observation | null;
    ownTrack: TrackerSnapshot;
  }[];
  allocations: Allocation[];
  held: boolean;
  heldIds: SensorId[];
  recovery: RecoveryStatus[];
  jointYieldIds: SensorId[];
  viewTasks: ViewTask[];
  motion: ThreeMotion["diagnostic"];
  adapterProposedMotion: {
    id: SensorId;
    displacement: { x: number; y: number; z: number };
  }[];
  commandedMotion: {
    id: SensorId;
    displacement: { x: number; y: number; z: number };
  }[];
}
export interface ThreeTimeline {
  fleet: 3;
  policyVersion: string;
  frames: ThreeFrame[];
  decisions: { t: number; allocations: Allocation[] }[];
  beliefEpochs: {
    t: number;
    sensors: {
      id: SensorId;
      owners: SensorId[];
      probability: number[];
      meanErrorM: number;
      trueCellNll: number;
      massRegion95AreaM2: number;
      massRegion95ContainsTruth: boolean;
    }[];
  }[];
  metrics: ReturnType<typeof observationMetrics>;
  diagnostics: Record<string, unknown>;
}
export function observationMetrics(sightings: readonly boolean[], dt: number) {
  let missing = 0,
    maxGap = 0,
    gap = 0,
    first: number | null = null;
  for (let i = 0; i < sightings.length; i++) {
    if (sightings[i]) {
      if (first === null) first = i * dt;
      maxGap = Math.max(maxGap, gap);
      gap = 0;
    } else {
      missing += dt;
      gap += dt;
    }
  }
  return {
    totalNoFixS: missing,
    initialAcquisitionS: first ?? sightings.length * dt,
    initialAcquired: first !== null,
    worstGapS: Math.max(maxGap, gap),
  };
}
export function simulateThreeTeam(
  scenario: TeamScenario,
  arm: TeamArm,
  options: {
    duration?: number;
    recordFrames?: boolean;
    /** Internal engineering ablation only; the product uses the versioned default. */
    motion?: ThreeMotionOptions;
  } = {},
): ThreeTimeline {
  const duration = options.duration ?? TEAM.duration,
    n = Math.round(duration / TEAM.dt),
    started = performance.now(),
    pub = scenario.public,
    w = pub.world,
    geometry = new ThreeGeometry(w),
    { stepDrone, stats: controllerStats } = createThreeController(geometry),
    map = new TeamMap(w, geometry),
    planner = new ThreePlanner(map),
    avoidance = new ThreeMotion(options.motion, geometry),
    recovery = new TeamRecovery(true, geometry),
    estimator = new ThreeEstimate(),
    subject = new ThreeSubjectAgent(
      w as ThreeWorld,
      scenario.hidden.goals,
      scenario.hidden.subjectSeed,
    );
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 300 ||
    Math.abs(duration / TEAM.dt - n) > 1e-8
  )
    throw Error("Invalid three-drone duration");
  let drones: Aircraft[] = initialThreeDrones(pub).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (
    drones
      .map((d) => d.id)
      .sort()
      .join("") !== "ABC"
  )
    throw Error("Exact A/B/C scenario cohort required");
  const initialPairs = allPairSweeps(drones, drones);
  if (
    drones.some((d) => {
      const clearance = clearanceState(w, d.state.pos, 0, geometry);
      return !clearance.physicalValid || clearance.totalDeficit > 1e-6;
    }) ||
    initialPairs.some((p) => p.distance < 4 - 1e-8)
  )
    throw Error("Invalid three-drone initial clearance or separation");
  const beliefs = new Map<SensorId, TeamBelief>(),
    own = new Map<SensorId, Tracker>();
  const shared = new TeamBelief(map, pub.prior, THREE_IDS);
  for (const d of drones) {
    beliefs.set(
      d.id,
      arm === "shared" || arm === "coordinated"
        ? shared
        : new TeamBelief(map, pub.prior, THREE_IDS),
    );
    own.set(d.id, new Tracker());
  }
  const queued = new Map<SensorId, Evidence[]>(THREE_IDS.map((id) => [id, []])),
    frames: ThreeFrame[] = [],
    decisions: { t: number; allocations: Allocation[] }[] = [],
    sightings: boolean[] = [],
    beliefEpochs: ThreeTimeline["beliefEpochs"] = [];
  const heldCounts: Record<string, number> = { A: 0, B: 0, C: 0 },
    holdRuns: Record<string, number> = { A: 0, B: 0, C: 0 },
    maxHoldRuns: Record<string, number> = { A: 0, B: 0, C: 0 },
    blockedCounts: Record<string, number> = { A: 0, B: 0, C: 0 };
  const capExpiredWhileQueued = { A: 0, B: 0, C: 0 };
  const countedQueueCaps = new Set<string>();
  let dronePhysicalInvalidFrames = 0,
    dronePhysicalInvalidSegments = 0,
    normalMarginDeficitIntroductions = 0;
  let allocations: Allocation[] = [],
    holds = 0,
    horizontalTravel = 0,
    travel3D = 0,
    minSeparation = Math.min(...initialPairs.map((p) => p.distance)),
    waterFrames = 0,
    penetrationFrames = 0,
    maxActualSpeed = 0,
    maxActualAcceleration = 0,
    maxHoldVelocityReset = 0;
  const maxAccelerationByStage = {
    inherited: 0,
    avoidance: 0,
    emergencyHold: 0,
  };
  let maxInheritedProjectionResidualM = 0;
  const previousVelocity = THREE_IDS.map(() => ({ x: 0, y: 0, z: 0 }));
  const minPairSeparation: Record<string, number> = Object.fromEntries(
    initialPairs.map((p) => [p.pair, p.distance]),
  );
  const assignedViewDwellS: Record<string, number> = { A: 0, B: 0, C: 0 };
  const setupMs = performance.now() - started;
  const tickTimes: number[] = [];
  const subjectWindows: {
    t: number;
    x: number;
    z: number;
    gait: number;
    progress: number;
    hold: boolean;
  }[] = [];
  let subjectLoopRun = 0,
    maxSubjectLoopRun = 0,
    subjectLoopWindows = 0;
  let priorSubject: ReturnType<ThreeSubjectAgent["snapshot"]> | null = null,
    subjectBlockedRun = 0,
    maxSubjectRouteBlockedS = 0,
    subjectNoProgressRun = 0,
    maxSubjectNoProgressS = 0;
  let everAcquired = false,
    postFixOccludedRun = 0,
    maxPostFixAllThreeGeometricCoverS = 0;
  let allOccludedRun = 0,
    maxAllOccludedS = 0,
    allOccludedS = 0;
  for (let i = 0; i <= n; i++) {
    const tickStarted = performance.now();
    const subjectExposure: ThreeFrame["subjectExposure"] = [];
    const t = i * TEAM.dt,
      truth = subject.snapshot(),
      obs = new Map<SensorId, Observation | null>();
    for (const d of drones) {
      const sigma =
          0.4 +
          0.02 *
            Math.hypot(
              d.state.pos.x - truth.x,
              d.state.pos.y - truth.y,
              d.state.pos.z - truth.z,
            ),
        noise = threeNoise(scenario.generation.subjectSeed, i, d.id);
      const noiseX = noise.x,
        noiseZ = noise.z;
      const detection = bodyDetection(geometry, d.state, truth.body);
      subjectExposure.push({
        id: d.id,
        visibleSamples: detection.visibleSamples,
        geometricallyBlockedSamples: detection.geometricallyBlockedSamples,
        inFrameSamples: detection.inFrameSamples,
        bodyValid: detection.bodyValid,
      });
      const o = detection.detected
        ? { t, x: truth.x + noiseX * sigma, z: truth.z + noiseZ * sigma, sigma }
        : null;
      obs.set(d.id, o);
      const tr = own.get(d.id)!;
      if (i > 0) tr.predict(TEAM.dt);
      if (o) tr.update(o);
      const sampleEmpty = i % Math.round(TEAM.evidencePeriod / TEAM.dt) === 0;
      if (o || sampleEmpty)
        queued.get(d.id)!.push({
          messageId: String(i),
          sensorId: d.id,
          sensedAt: t,
          receivedAt: t,
          pose: {
            ...d.state.pos,
            yaw: d.state.camYaw,
            pitch: d.state.camPitch,
          },
          observation: o,
        });
    }
    let accepted: Evidence[] = [];
    if (i % Math.round(TEAM.evidencePeriod / TEAM.dt) === 0) {
      if (arm === "shared" || arm === "coordinated")
        accepted = shared.ingest(
          THREE_IDS.flatMap((id) => queued.get(id)!),
          t,
        );
      else
        for (const d of drones) beliefs.get(d.id)!.ingest(queued.get(d.id)!, t);
      for (const q of queued.values()) q.length = 0;
    }
    if (i < n) sightings.push([...obs.values()].some(Boolean));
    everAcquired ||= [...obs.values()].some(Boolean);
    if (inWater(w, truth.x, truth.z)) waterFrames++;
    if (priorSubject) {
      const a = priorSubject.body.posture,
        b = truth.body.posture;
      const changed =
        Math.hypot(truth.x - priorSubject.x, truth.z - priorSubject.z) > 1e-5 ||
        Math.abs(
          Math.atan2(
            Math.sin(truth.heading - priorSubject.heading),
            Math.cos(truth.heading - priorSubject.heading),
          ),
        ) > 1e-4 ||
        (b.progress > 1e-4 &&
          (a.from !== b.from ||
            a.to !== b.to ||
            b.progress > a.progress + 1e-4));
      subjectNoProgressRun =
        !truth.intentionalHold && !changed ? subjectNoProgressRun + TEAM.dt : 0;
      subjectBlockedRun =
        truth.behavior === "route-blocked" ? subjectBlockedRun + TEAM.dt : 0;
      maxSubjectNoProgressS = Math.max(
        maxSubjectNoProgressS,
        subjectNoProgressRun,
      );
      maxSubjectRouteBlockedS = Math.max(
        maxSubjectRouteBlockedS,
        subjectBlockedRun,
      );
    }
    priorSubject = truth;
    subjectWindows.push({
      t,
      x: truth.x,
      z: truth.z,
      gait: truth.gait,
      progress: truth.routeProgressTotalM,
      hold: truth.intentionalHold,
    });
    while (subjectWindows.length > 1 && t - subjectWindows[1].t >= 8)
      subjectWindows.shift();
    const firstSubject = subjectWindows[0],
      loop =
        t - firstSubject.t >= 8 - 1e-8 &&
        !subjectWindows.some((p) => p.hold) &&
        truth.gait - firstSubject.gait >= 12 &&
        Math.hypot(truth.x - firstSubject.x, truth.z - firstSubject.z) < 2 &&
        truth.routeProgressTotalM - firstSubject.progress < 1;
    subjectLoopRun = loop ? subjectLoopRun + TEAM.dt : 0;
    maxSubjectLoopRun = Math.max(maxSubjectLoopRun, subjectLoopRun);
    if (loop) subjectLoopWindows++;
    const physicalBody = geometry.bodyValid(bodyPose(truth.body, w));
    if (!physicalBody) penetrationFrames++;
    if (i < n) {
      const all =
        physicalBody &&
        truth.intentionalHold &&
        subjectExposure.every((e) => e.geometricallyBlockedSamples === 9);
      postFixOccludedRun =
        all && everAcquired ? postFixOccludedRun + TEAM.dt : 0;
      maxPostFixAllThreeGeometricCoverS = Math.max(
        maxPostFixAllThreeGeometricCoverS,
        postFixOccludedRun,
      );
      allOccludedRun = all ? allOccludedRun + TEAM.dt : 0;
      maxAllOccludedS = Math.max(maxAllOccludedS, allOccludedRun);
      if (all) allOccludedS += TEAM.dt;
    }
    for (const d of drones) {
      const local = own.get(d.id)!.snapshot();
      d.searching =
        !local.initialised ||
        local.status === "SEARCHING" ||
        local.status === "REACQUIRING";
    }
    const ownSnapshots = new Map(
      drones.map((d) => [d.id, own.get(d.id)!.snapshot()]),
    );
    const estimate =
      arm === "shared" || arm === "coordinated"
        ? estimator.update(accepted, t, shared.controlSnapshot())
        : null;
    const planChanged =
      i < n &&
      t >= TEAM.initializationS &&
      planner.update(t, drones, beliefs, ownSnapshots, arm, estimate);
    if (planChanged) {
      beliefEpochs.push({
        t,
        sensors: (arm === "shared" || arm === "coordinated"
          ? drones.slice(0, 1)
          : drones
        ).map((d) => {
          const belief = beliefs.get(d.id)!,
            p = belief.probability,
            order = [...p.keys()].sort((a, b) => p[b] - p[a] || a - b);
          const truthCell = map.index(truth.x, truth.z),
            region = new Set<number>();
          let mass = 0,
            area = 0;
          for (const k of order) {
            region.add(k);
            mass += p[k];
            area += map.cells[k].area;
            if (mass >= 0.95) break;
          }
          const mean = belief.summary();
          return {
            id: d.id,
            owners:
              arm === "shared" || arm === "coordinated"
                ? [...THREE_IDS]
                : [d.id],
            probability: [...p],
            meanErrorM: Math.hypot(mean.x - truth.x, mean.z - truth.z),
            trueCellNll: -Math.log(Math.max(1e-300, p[truthCell])),
            massRegion95AreaM2: area,
            massRegion95ContainsTruth: region.has(truthCell),
          };
        }),
      });
      allocations = planner.getAllocations();
      // Refresh the inherited one-second waypoint latch together with the new gaze.
      for (const d of drones) d.state.replanT = 0;
      decisions.push({ t, allocations });
    }
    const before = structuredClone(drones);
    let held = false;
    let heldIds: SensorId[] = [];
    let adapterProposedMotion: ThreeFrame["adapterProposedMotion"] = [];
    let commandedMotion: ThreeFrame["commandedMotion"] = [];
    for (const d of before)
      if (!physicalMotion(w, d.state.pos, d.state.pos, geometry))
        dronePhysicalInvalidFrames++;
    if (i < n && t >= TEAM.initializationS) {
      const next = structuredClone(drones);
      for (const d of next) {
        const local = own.get(d.id)!.snapshot(),
          belief = beliefs.get(d.id)!,
          global = belief.controlSnapshot();
        // Own fixes govern each mode. A teammate's sighting cannot falsely make this drone see/follow.
        const control = hasRecentOwnFix(local)
          ? local
          : {
              ...global,
              status: local.initialised ? local.status : "SEARCHING",
              hits: local.hits,
            };
        const task = planner.getTask(d.id);
        if (task) control.status = "SEARCHING";
        const allocation = allocations.find((a) => a.id === d.id),
          useful =
            task &&
            hasRecentOwnFix(local) &&
            Math.hypot(
              d.state.pos.x - task.goal.x,
              d.state.pos.z - task.goal.z,
              d.state.pos.y - w.heightAt(task.goal.x, task.goal.z) - 3,
            ) <= 2,
          hover = useful ? { x: d.state.pos.x, z: d.state.pos.z } : null,
          guidance: SearchGuidance = {
            chooseViewpoint: () => hover ?? allocation?.waypoint ?? null,
            gazeTarget: () =>
              task && hasRecentOwnFix(local)
                ? { x: local.x, z: local.z }
                : (allocation?.gaze ?? null),
          };
        if (hover) d.state.replanT = 0;
        stepDrone(w, d.state, control, belief.summary(), t, TEAM.dt, guidance);
      }
      for (let k = 0; k < next.length; k++) {
        // Inherited controller adjusts velocity by 0.2*projection/dt after integrating position.
        // Therefore final displacement minus final velocity*dt equals 0.8*the projection correction.
        const p = before[k].state.pos,
          q = next[k].state.pos,
          v = next[k].state.vel;
        maxInheritedProjectionResidualM = Math.max(
          maxInheritedProjectionResidualM,
          Math.hypot(
            q.x - p.x - v.x * TEAM.dt,
            q.y - p.y - v.y * TEAM.dt,
            q.z - p.z - v.z * TEAM.dt,
          ) / 0.8,
        );
      }
      commandedMotion = next.map((d, k) => ({
        id: d.id,
        displacement: {
          x: d.state.pos.x - before[k].state.pos.x,
          y: d.state.pos.y - before[k].state.pos.y,
          z: d.state.pos.z - before[k].state.pos.z,
        },
      }));
      const previousQueue = avoidance.diagnostic.detourQueue;
      recovery.apply(w, before, next, t, TEAM.dt, true);
      for (const state of recovery.snapshot()) {
        const key = state.id + ":" + state.since;
        if (
          state.state === "blocked" &&
          state.reason.includes("absolute cap") &&
          !countedQueueCaps.has(key)
        ) {
          countedQueueCaps.add(key);
          if (
            previousQueue.some(
              (q) => q.id === state.id && q.pendingFirstService,
            )
          )
            capExpiredWhileQueued[state.id]++;
        }
      }
      adapterProposedMotion = next.map((d, k) => ({
        id: d.id,
        displacement: {
          x: d.state.pos.x - before[k].state.pos.x,
          y: d.state.pos.y - before[k].state.pos.y,
          z: d.state.pos.z - before[k].state.pos.z,
        },
      }));
      const intervened = avoidance.apply(
        w,
        before,
        next,
        t,
        TEAM.dt,
        new Map(
          recovery
            .snapshot()
            .filter((s) => s.state === "recovering" && s.target)
            .map((s) => [s.id, s.target!]),
        ),
      );
      if (avoidance.replanRequested) planner.requestConflictReplan(t + TEAM.dt);
      heldIds = [
        ...new Set<SensorId>([...recovery.heldIds, ...avoidance.emergencyIds]),
      ];
      heldIds = heldIds.filter((id) => {
        const a = before.find((d) => d.id === id)!.state.pos,
          b = next.find((d) => d.id === id)!.state.pos;
        return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) <= 1e-8;
      });
      held = heldIds.length > 0;
      recovery.audit(w, before, next, TEAM.dt, t);
      for (let k = 0; k < next.length; k++) {
        const id = next[k].id,
          isHeld = heldIds.includes(id);
        heldCounts[id] += Number(isHeld);
        holdRuns[id] = isHeld ? holdRuns[id] + 1 : 0;
        maxHoldRuns[id] = Math.max(maxHoldRuns[id], holdRuns[id]);
        if (isHeld)
          maxHoldVelocityReset = Math.max(
            maxHoldVelocityReset,
            Math.hypot(
              previousVelocity[k].x,
              previousVelocity[k].y,
              previousVelocity[k].z,
            ),
          );
        if (
          !physicalMotion(w, before[k].state.pos, next[k].state.pos, geometry)
        )
          dronePhysicalInvalidSegments++;
        if (
          clearanceState(w, before[k].state.pos, 0, geometry).totalDeficit <=
            1e-6 &&
          clearanceState(w, next[k].state.pos, 0, geometry).totalDeficit > 1e-6
        )
          normalMarginDeficitIntroductions++;
      }
      for (const state of recovery.snapshot())
        if (state.state === "blocked") blockedCounts[state.id]++;
      if (held) holds++;
      for (const pair of allPairSweeps(before, next)) {
        minSeparation = Math.min(minSeparation, pair.distance);
        minPairSeparation[pair.pair] = Math.min(
          minPairSeparation[pair.pair],
          pair.distance,
        );
      }
      for (const task of planner.snapshot()) {
        const index = before.findIndex((d) => d.id === task.id),
          a = before[index].state.pos,
          b = next[index].state.pos;
        const ownFix = ownSnapshots.get(task.id)!,
          useful =
            hasRecentOwnFix(ownFix) &&
            Math.hypot(
              a.x - task.goal.x,
              a.z - task.goal.z,
              a.y - w.heightAt(task.goal.x, task.goal.z) - 3,
            ) <= 2;
        const command = commandedMotion[index].displacement;
        const holding =
          useful &&
          Math.hypot(command.x, command.y, command.z) < 1e-5 &&
          Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-5 &&
          !heldIds.includes(task.id);
        task.state = holding ? "holding" : useful ? "settling" : "moving";
        task.ownConfirmed = hasRecentOwnFix(ownFix);
        if (holding) assignedViewDwellS[task.id] += TEAM.dt;
      }
      for (let k = 0; k < next.length; k++) {
        const a = before[k].state.pos,
          b = next[k].state.pos;
        horizontalTravel += Math.hypot(b.x - a.x, b.z - a.z);
        travel3D += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        const v = {
          x: (b.x - a.x) / TEAM.dt,
          y: (b.y - a.y) / TEAM.dt,
          z: (b.z - a.z) / TEAM.dt,
        };
        const prev = previousVelocity[k];
        maxActualSpeed = Math.max(maxActualSpeed, Math.hypot(v.x, v.y, v.z));
        maxActualAcceleration = Math.max(
          maxActualAcceleration,
          Math.hypot(v.x - prev.x, v.y - prev.y, v.z - prev.z) / TEAM.dt,
        );
        const category = heldIds.includes(next[k].id)
          ? "emergencyHold"
          : intervened
            ? "avoidance"
            : "inherited";
        maxAccelerationByStage[category] = Math.max(
          maxAccelerationByStage[category],
          Math.hypot(v.x - prev.x, v.y - prev.y, v.z - prev.z) / TEAM.dt,
        );
        previousVelocity[k] = v;
      }
      drones = next;
    }
    if (options.recordFrames !== false)
      frames.push({
        i,
        t,
        subject: truth,
        subjectExposure,
        aircraft: before.map((d) => ({
          id: d.id,
          state: d.state,
          observation: obs.get(d.id)!,
          ownTrack: own.get(d.id)!.snapshot(),
        })),
        allocations,
        held,
        heldIds,
        recovery: recovery.snapshot(),
        commandedMotion,
        adapterProposedMotion,
        jointYieldIds: [...recovery.jointYieldIds],
        viewTasks: structuredClone(planner.snapshot()),
        motion: avoidance.diagnostic,
      });
    if (i < n)
      subject.step(
        before.map((d) => ({
          id: d.id,
          position: { x: d.state.pos.x, y: d.state.pos.y, z: d.state.pos.z },
        })),
        TEAM.dt,
      );
    tickTimes.push(performance.now() - tickStarted);
  }
  const metrics = observationMetrics(sightings, TEAM.dt);
  return {
    fleet: 3,
    policyVersion: THREE_VERSION,
    frames,
    decisions,
    beliefEpochs,
    metrics,
    diagnostics: {
      arm,
      subjectVersion: SUBJECT_VERSION,
      bodyVersion: BODY_VERSION,
      sensorVersion: SENSOR_VERSION,
      worldVersion: (w as ThreeWorld).n3WorldVersion,
      subjectPolicy: subject.stats,
      maxPostFixAllThreeGeometricCoverS,
      maxSubjectNoProgressS,
      maxSubjectRouteBlockedS,
      subjectLoopWindows,
      maxSubjectLoopRunS: maxSubjectLoopRun,
      allThreeGeometricCoverS: allOccludedS,
      maxAllThreeGeometricCoverS: maxAllOccludedS,
      controller: controllerStats,
      setupMs,
      steppingMs: performance.now() - started - setupMs,
      tickP95Ms: [...tickTimes].sort((a, b) => a - b)[
        Math.floor(tickTimes.length * 0.95)
      ],
      tickMaxMs: Math.max(...tickTimes),
      avoidanceEnabled: true,
      avoidance: avoidance.stats,
      recovery: recovery.stats,
      capExpiredWhileQueued,
      ...(recovery.extendedStats
        ? { extendedRecovery: recovery.extendedStats }
        : {}),
      dronePhysicalInvalidFrames,
      dronePhysicalInvalidSegments,
      normalMarginDeficitIntroductions,
      holdSecondsById: Object.fromEntries(
        Object.entries(heldCounts).map(([k, v]) => [k, v * TEAM.dt]),
      ),
      maxConsecutiveHoldSById: Object.fromEntries(
        Object.entries(maxHoldRuns).map(([k, v]) => [k, v * TEAM.dt]),
      ),
      blockedSecondsById: Object.fromEntries(
        Object.entries(blockedCounts).map(([k, v]) => [k, v * TEAM.dt]),
      ),
      maxActualAccelerationByStageMps2: maxAccelerationByStage,
      maxInheritedProjectionCorrectionM: maxInheritedProjectionResidualM,
      generation: scenario.generation,
      holds,
      holdSeconds: holds * TEAM.dt,
      maxActualSpeedMps: maxActualSpeed,
      maxActualAccelerationMps2: maxActualAcceleration,
      maxHoldVelocityResetMps: maxHoldVelocityReset,
      horizontalTravelM: horizontalTravel,
      travel3DM: travel3D,
      minSweptSeparationM: minSeparation,
      minSweptSeparationByPairM: minPairSeparation,
      assignedViewDwellS,
      waterFrames,
      subjectPenetrationFrames: penetrationFrames,
      cachedViewPositions: planner.cachedViewPositions,
      planner: planner.stats,

      ledgers: Object.fromEntries(
        [...beliefs].map(([id, b]) => [id, { ...b.ledger.stats, ...b.stats }]),
      ),
      wallMs: performance.now() - started,
    },
  };
}
