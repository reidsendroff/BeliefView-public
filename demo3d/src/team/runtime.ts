/** Simulation/evaluation orchestrator. Hidden state stays here, never in ledger/filter/planner inputs. */
import { stepDrone, type DroneState, type SearchGuidance } from "../sim/drone";
import { Tracker } from "../sim/tracker";
import { Rng } from "../sim/rng";
import type { Observation, TrackerSnapshot } from "../sim/types";
import { inWater } from "../sim/richWorld";
import { TeamAssist, hasRecentOwnFix, type AssistStatus } from "./assist";
import { TeamRecovery, type RecoveryStatus } from "./recovery";
import { physicalMotion, clearanceState } from "./clearance";
import { TeamAvoidance } from "./avoidance";
import { TeamMap } from "./map";
import { TeamBelief } from "./belief";
import { TeamPlanner, type Aircraft, type Allocation } from "./planner";
import {
  canSense,
  initialDrones,
  makeSubject,
  nearestDrone,
  type TeamScenario,
} from "./scenario";
import { enforceSeparation, sweptSeparation } from "./separation";
import { TEAM, type Evidence, type SensorId, type TeamArm } from "./types";
export interface TeamFrame {
  i: number;
  t: number;
  subject: ReturnType<ReturnType<typeof makeSubject>["snapshot"]>;
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
  assist?: AssistStatus[];
  adapterProposedMotion: {
    id: SensorId;
    displacement: { x: number; y: number; z: number };
  }[];
  commandedMotion: {
    id: SensorId;
    displacement: { x: number; y: number; z: number };
  }[];
}
export interface TeamTimeline {
  frames: TeamFrame[];
  decisions: { t: number; allocations: Allocation[] }[];
  beliefEpochs: {
    t: number;
    sensors: {
      id: SensorId;
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
export function simulateTeam(
  scenario: TeamScenario,
  arm: TeamArm,
  options: {
    duration?: number;
    recordFrames?: boolean;
    avoidance?: boolean;
    recovery?: boolean;
    assist?: boolean;
    extendedRecovery?: boolean;
  } = {},
): TeamTimeline {
  const duration = options.duration ?? TEAM.duration,
    n = Math.round(duration / TEAM.dt),
    started = performance.now(),
    pub = scenario.public,
    w = pub.world,
    map = new TeamMap(w),
    planner = new TeamPlanner(map),
    avoidance = new TeamAvoidance(),
    recovery = new TeamRecovery(options.extendedRecovery ?? false),
    assist =
      options.assist && (arm === "shared" || arm === "coordinated")
        ? new TeamAssist(map, planner)
        : null,
    subject = makeSubject(pub, scenario.hidden);
  let drones: Aircraft[] = initialDrones(pub);
  const beliefs = new Map<SensorId, TeamBelief>(),
    own = new Map<SensorId, Tracker>();
  const shared = new TeamBelief(map, pub.prior);
  for (const d of drones) {
    beliefs.set(
      d.id,
      arm === "shared" || arm === "coordinated"
        ? shared
        : new TeamBelief(map, pub.prior),
    );
    own.set(d.id, new Tracker());
  }
  const queued = new Map<SensorId, Evidence[]>([
      ["A", []],
      ["B", []],
    ]),
    frames: TeamFrame[] = [],
    decisions: { t: number; allocations: Allocation[] }[] = [],
    sightings: boolean[] = [],
    beliefEpochs: TeamTimeline["beliefEpochs"] = [];
  const heldCounts: Record<string, number> = { A: 0, B: 0 },
    holdRuns: Record<string, number> = { A: 0, B: 0 },
    maxHoldRuns: Record<string, number> = { A: 0, B: 0 },
    blockedCounts: Record<string, number> = { A: 0, B: 0 };
  let dronePhysicalInvalidFrames = 0,
    dronePhysicalInvalidSegments = 0,
    normalMarginDeficitIntroductions = 0;
  let allocations: Allocation[] = [],
    nextPlan = TEAM.initializationS,
    holds = 0,
    horizontalTravel = 0,
    travel3D = 0,
    minSeparation = Infinity,
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
  const previousVelocity = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ];
  for (let i = 0; i <= n; i++) {
    const t = i * TEAM.dt,
      truth = subject.snapshot(),
      obs = new Map<SensorId, Observation | null>();
    for (const d of drones) {
      const sigma =
          0.4 +
          0.02 *
            Math.hypot(
              d.state.pos.x - truth.x,
              d.state.pos.y - (truth.y + 1.3 - 0.65 * truth.crouch),
              d.state.pos.z - truth.z,
            ),
        rng = new Rng(
          (scenario.generation.subjectSeed ^
            Math.imul(i + 1, 0x45d9f3b) ^
            (d.id === "A" ? 0x5a1 : 0xb12)) >>>
            0,
        );
      const noiseX = rng.normal(),
        noiseZ = rng.normal();
      const o = canSense(w, d.state, truth)
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
        accepted = shared.ingest([...queued.get("A")!, ...queued.get("B")!], t);
      else
        for (const d of drones) beliefs.get(d.id)!.ingest(queued.get(d.id)!, t);
      for (const q of queued.values()) q.length = 0;
    }
    if (i < n) sightings.push([...obs.values()].some(Boolean));
    if (inWater(w, truth.x, truth.z)) waterFrames++;
    if (
      w.trees.some(
        (tree) =>
          tree.trunkR > 0 &&
          Math.hypot(tree.x - truth.x, tree.z - truth.z) < tree.trunkR - 1e-6,
      )
    )
      penetrationFrames++;
    for (const d of drones) {
      const local = own.get(d.id)!.snapshot();
      d.searching =
        !local.initialised ||
        local.status === "SEARCHING" ||
        local.status === "REACQUIRING";
    }
    const assistChanged =
      i < n &&
      (assist?.update(
        t,
        drones,
        new Map(drones.map((d) => [d.id, own.get(d.id)!.snapshot()])),
        accepted,
      ) ??
        false);
    const assistAllocations = assist?.allocations() ?? [];
    if ((t >= nextPlan - 1e-8 || assistChanged) && i < n) {
      beliefEpochs.push({
        t,
        sensors: drones.map((d) => {
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
            probability: [...p],
            meanErrorM: Math.hypot(mean.x - truth.x, mean.z - truth.z),
            trueCellNll: -Math.log(Math.max(1e-300, p[truthCell])),
            massRegion95AreaM2: area,
            massRegion95ContainsTruth: region.has(truthCell),
          };
        }),
      });
      const planningArm =
        arm === "coordinated" && assistAllocations.length ? "shared" : arm;
      allocations = planner.plan(drones, beliefs, planningArm);
      if (assistAllocations.length) {
        allocations = allocations.filter(
          (a) => !assistAllocations.some((b) => a.id === b.id),
        );
        if (arm === "coordinated")
          allocations = allocations.map((a) => ({
            ...a,
            overlap: null,
            reason:
              "Independent shared-belief allocation while teammate assist overrides joint planning",
          }));
        allocations.push(...assistAllocations);
      }
      // Refresh the inherited one-second waypoint latch together with the new gaze.
      for (const d of drones) d.state.replanT = 0;
      decisions.push({ t, allocations });
      if (t >= nextPlan - 1e-8) nextPlan += TEAM.replanPeriod;
    }
    const before = structuredClone(drones);
    let held = false;
    let heldIds: SensorId[] = [];
    let adapterProposedMotion: TeamFrame["adapterProposedMotion"] = [];
    let commandedMotion: TeamFrame["commandedMotion"] = [];
    for (const d of before)
      if (!physicalMotion(w, d.state.pos, d.state.pos))
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
        if (assistAllocations.some((a) => a.id === d.id))
          control.status = "SEARCHING";
        const allocation = allocations.find((a) => a.id === d.id),
          guidance: SearchGuidance = {
            chooseViewpoint: () => allocation?.waypoint ?? null,
            gazeTarget: () => allocation?.gaze ?? null,
          };
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
      recovery.apply(
        w,
        before,
        next,
        t,
        TEAM.dt,
        options.recovery ?? options.avoidance !== false,
      );
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
        options.avoidance !== false,
        recovery.activeIds,
        new Map(
          recovery
            .snapshot()
            .filter((s) => s.state === "recovering" && s.target)
            .map((s) => [s.id, s.target!]),
        ),
      );
      const separationHeld = enforceSeparation(before, next);
      heldIds = [
        ...new Set<SensorId>([
          ...recovery.heldIds,
          ...avoidance.emergencyIds,
          ...(separationHeld ? before.map((d) => d.id) : []),
        ]),
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
        if (!physicalMotion(w, before[k].state.pos, next[k].state.pos))
          dronePhysicalInvalidSegments++;
        if (
          clearanceState(w, before[k].state.pos).totalDeficit <= 1e-6 &&
          clearanceState(w, next[k].state.pos).totalDeficit > 1e-6
        )
          normalMarginDeficitIntroductions++;
      }
      for (const state of recovery.snapshot())
        if (state.state === "blocked") blockedCounts[state.id]++;
      if (held) holds++;
      minSeparation = Math.min(
        minSeparation,
        sweptSeparation(
          before[0].state,
          next[0].state,
          before[1].state,
          next[1].state,
        ),
      );
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
        ...(assist ? { assist: assist.snapshot() } : {}),
      });
    if (i < n) subject.step(nearestDrone(before, truth), TEAM.dt);
  }
  const metrics = observationMetrics(sightings, TEAM.dt);
  return {
    frames,
    decisions,
    beliefEpochs,
    metrics,
    diagnostics: {
      arm,
      avoidanceEnabled: options.avoidance !== false,
      avoidance: avoidance.stats,
      recovery: recovery.stats,
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
      waterFrames,
      subjectPenetrationFrames: penetrationFrames,
      cachedViewPositions: map.cachedPositions,
      planner: planner.stats,
      ...(assist ? { assist: assist.stats } : {}),
      ledgers: Object.fromEntries(
        [...beliefs].map(([id, b]) => [id, { ...b.ledger.stats, ...b.stats }]),
      ),
      wallMs: performance.now() - started,
    },
  };
}
