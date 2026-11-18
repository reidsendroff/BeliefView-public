/** Rendering transport only. No output from this module is accepted by the team policy. */
import type { TeamTimeline } from "./runtime";
import type { ThreeTimeline } from "./threeRuntime";
import { THREE_VERSION } from "./threeConstants";
import { BODY_VERSION, bodyPose } from "./threeBody";
import { ThreeGeometry } from "./threeGeometry";
import { SUBJECT_VERSION } from "./threeSubject";
import { isThreeWorld } from "./threeWorld";
import type { SensorId } from "./types";
export type ReplayTimeline = TeamTimeline | ThreeTimeline;
export type ReplayFrame = ReplayTimeline["frames"][number];
export const fleetIds = (fleet: 2 | 3): SensorId[] =>
  fleet === 3 ? ["A", "B", "C"] : ["A", "B"];
export const replayFleet = (value: string | null): 2 | 3 =>
  value === "3" ? 3 : 2;
export const replayFocus = (value: string | null, fleet: 2 | 3): SensorId =>
  fleetIds(fleet).includes(value as SensorId) ? (value as SensorId) : "A";
import { buildPublicScenario } from "./scenario";
import type { TeamArm } from "./types";
import type { Timeline } from "../sim/simulate";
import { blockerToReason, lineOfSight } from "../sim/geometry";
import { fovTest } from "../sim/sensor";
export const ARMS: TeamArm[] = [
  "independent",
  "sector",
  "shared",
  "coordinated",
];
export const ARM_LABELS: Record<TeamArm, string> = {
  independent: "Independent beliefs",
  sector: "Independent + fixed sectors",
  shared: "Shared belief",
  coordinated: "Shared + complementary views (experimental)",
};
export const MISSION_DURATIONS = [75, 180, 300] as const;
export function replayDuration(value: string | null): 75 | 180 | 300 {
  return value === "75" ? 75 : value === "300" ? 300 : 180;
}
export function replayQuery(q: URLSearchParams) {
  const a = q.get("teamarm"),
    index = Number(q.get("missionIndex") ?? 16);
  return {
    fleet: replayFleet(q.get("fleet")),
    duration: replayDuration(q.get("duration")),
    arm: ARMS.includes(a as TeamArm) ? (a as TeamArm) : ("shared" as TeamArm),
    index: Number.isInteger(index) && index >= 0 && index < 32 ? index : 0,
    family:
      q.get("terrain") === "original"
        ? ("original" as const)
        : ("rich" as const),
  };
}
export function validateReplayHorizon(team: ReplayTimeline, duration: number) {
  const dt = 0.05,
    count = Math.round(duration / dt) + 1;
  if (
    team.frames.length !== count ||
    team.frames.some(
      (f, i) =>
        f.i !== i || !Number.isFinite(f.t) || Math.abs(f.t - i * dt) > 1e-8,
    )
  )
    throw new Error("Timeline duration mismatch. Replay was not rendered.");
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function deterministicReplay(timeline: ReplayTimeline) {
  return {
    ...("fleet" in timeline
      ? { fleet: timeline.fleet, policyVersion: timeline.policyVersion }
      : {}),
    frames: timeline.frames,
    decisions: timeline.decisions,
    beliefEpochs: timeline.beliefEpochs,
    metrics: timeline.metrics,
  };
}
export async function mapFingerprint(
  publicScenario: ReturnType<typeof buildPublicScenario>,
) {
  const w = publicScenario.world,
    heights = [];
  for (let x = -90; x <= 90; x += 6)
    for (let z = -90; z <= 90; z += 6) heights.push(w.heightAt(x, z));
  return digest({
    seed: w.seed,
    half: w.half,
    trees: w.trees,
    rocks: w.rocks,
    heights,
    prior: publicScenario.prior,
    starts: publicScenario.starts,
    ...(isThreeWorld(w)
      ? {
          n3WorldVersion: w.n3WorldVersion,
          n3Solids: w.n3Solids,
          n3Covers: w.n3Covers,
        }
      : {}),
  });
}
export function spectatorTimeline(
  team: ReplayTimeline,
  publicScenario: ReturnType<typeof buildPublicScenario>,
  id: SensorId = "A",
): Timeline {
  const world = publicScenario.world;
  const geometry = isThreeWorld(world) ? new ThreeGeometry(world) : null;
  return {
    world,
    config: {
      seed: world.seed,
      subjectSeed: 0,
      duration: team.frames.at(-1)!.t,
      dt: team.frames.length > 1 ? team.frames[1].t - team.frames[0].t : 0.05,
      waypoints: [],
    },
    events: [],
    frames: team.frames.map((f) => {
      const a = f.aircraft.find((a) => a.id === id)!,
        d = a.state,
        subject = f.subject;
      const torso = {
        x: subject.x,
        y: subject.y + 1.3 - 0.65 * subject.crouch,
        z: subject.z,
      };
      const fov = fovTest(d.pos, d.camYaw, d.camPitch, torso);
      let visibility = !fov.inRange
        ? "OUT_OF_RANGE"
        : !fov.inFov
          ? "OUT_OF_FOV"
          : blockerToReason(lineOfSight(world, d.pos, torso));
      if (geometry && "subjectExposure" in f && "body" in subject) {
        const exposure = f.subjectExposure.find((e) => e.id === id)!;
        if (exposure.visibleSamples > 0 && exposure.bodyValid)
          visibility = "VISIBLE";
        else {
          const samples = bodyPose(subject.body, world).samples;
          const framed = samples.find((s) => {
            const test = fovTest(d.pos, d.camYaw, d.camPitch, s.point);
            return test.inRange && test.inFov;
          });
          visibility = framed
            ? blockerToReason(geometry.lineOfSight(d.pos, framed.point))
            : samples.some(
                  (s) => fovTest(d.pos, d.camYaw, d.camPitch, s.point).inRange,
                )
              ? "OUT_OF_FOV"
              : "OUT_OF_RANGE";
        }
      }
      return {
        i: f.i,
        t: f.t,
        subject,
        drone: {
          ...d.pos,
          yaw: d.yaw,
          vx: d.vel.x,
          vy: d.vel.y,
          vz: d.vel.z,
          agl: d.pos.y - world.heightAt(d.pos.x, d.pos.z),
        },
        cam: { yaw: d.camYaw, pitch: d.camPitch },
        obs: a.observation,
        visibility,
        track: {
          ...a.ownTrack,
          status: a.ownTrack.initialised ? a.ownTrack.status : "SEARCHING",
        },
        mode: d.mode,
        viewpoint: d.viewpoint,
      };
    }),
  };
}

/** Presentation transport validation, never policy input. */
export function validateBodyReplaySubject(
  subject: unknown,
  ground?: { heightAt(x: number, z: number): number },
): void {
  const s = subject as {
    subjectVersion?: unknown;
    bodyVersion?: unknown;
    x?: unknown;
    y?: unknown;
    z?: unknown;
    body?: {
      root?: { x?: unknown; y?: unknown; z?: unknown };
      heading?: unknown;
      gait?: unknown;
      speed?: unknown;
      posture?: { from?: unknown; to?: unknown; progress?: unknown };
    };
  };
  const body = s?.body,
    posture = body?.posture,
    values = [
      body?.root?.x,
      body?.root?.y,
      body?.root?.z,
      body?.heading,
      body?.gait,
      body?.speed,
      posture?.progress,
    ];
  if (
    s?.subjectVersion !== SUBJECT_VERSION ||
    s?.bodyVersion !== BODY_VERSION ||
    !values.every((v) => typeof v === "number" && Number.isFinite(v)) ||
    !["standing", "crouched", "kneeling", "prone"].includes(
      String(posture?.from),
    ) ||
    !["standing", "crouched", "kneeling", "prone"].includes(
      String(posture?.to),
    ) ||
    Number(posture?.progress) < 0 ||
    Number(posture?.progress) > 1 ||
    Number(body?.speed) < 0 ||
    body?.root?.x !== s.x ||
    body?.root?.y !== s.y ||
    body?.root?.z !== s.z
  )
    throw Error("Timeline body contract mismatch. Replay was not rendered.");
  if (ground) {
    const y = ground.heightAt(Number(body?.root?.x), Number(body?.root?.z));
    if (!Number.isFinite(y) || Math.abs(Number(body?.root?.y) - y) > 0.005)
      throw Error("Timeline body grounding mismatch. Replay was not rendered.");
  }
}

/** Reject malformed transport before any camera or evidence is rendered. */
export function validateReplayFleet(
  team: ReplayTimeline,
  fleet: 2 | 3,
  arm: TeamArm,
  ground?: { heightAt(x: number, z: number): number },
) {
  const ids = fleetIds(fleet),
    shared = arm === "shared" || arm === "coordinated";
  const reject = () => {
    throw new Error("Timeline drone cohort mismatch. Replay was not rendered.");
  };
  const subset = (values: unknown, exact = false): void => {
    if (
      !Array.isArray(values) ||
      values.some((id) => !ids.includes(id)) ||
      new Set(values).size !== values.length ||
      (exact && values.length !== ids.length)
    )
      reject();
  };
  const rows = (values: unknown, exact = false) => {
    if (!Array.isArray(values)) reject();
    subset(
      (values as { id: SensorId }[]).map((row) => row?.id),
      exact,
    );
  };
  if (
    (fleet === 3 && (!("fleet" in team) || team.fleet !== 3)) ||
    (fleet === 2 && "fleet" in team && Number(team.fleet) !== 2)
  )
    reject();
  if (team.diagnostics.arm !== arm) reject();
  if (
    fleet === 3 &&
    (!("policyVersion" in team) || team.policyVersion !== THREE_VERSION)
  )
    reject();
  const finite = (values: unknown[]) => {
    if (
      !values.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    )
      reject();
  };
  for (const frame of team.frames) {
    if (fleet === 3) {
      validateBodyReplaySubject(frame.subject, ground);
      if (!("subjectExposure" in frame)) reject();
      else {
        rows(frame.subjectExposure, true);
        for (const e of frame.subjectExposure)
          if (
            ![
              e.visibleSamples,
              e.geometricallyBlockedSamples,
              e.inFrameSamples,
            ].every((v) => Number.isInteger(v) && v >= 0 && v <= 9) ||
            typeof e.bodyValid !== "boolean"
          )
            reject();
      }
    }
    rows(frame.aircraft, true);
    for (const drone of frame.aircraft) {
      const state = drone.state;
      finite([
        state?.pos?.x,
        state?.pos?.y,
        state?.pos?.z,
        state?.vel?.x,
        state?.vel?.y,
        state?.vel?.z,
        state?.yaw,
        state?.camYaw,
        state?.camPitch,
      ]);
      const observation = drone.observation;
      if (observation !== null) {
        finite([
          observation?.t,
          observation?.x,
          observation?.z,
          observation?.sigma,
        ]);
        if (observation.sigma <= 0 || observation.t > frame.t + 1e-8) reject();
      }
    }
    rows(frame.allocations);
    rows(frame.recovery);
    const activeMotion = frame.t >= 1 && frame !== team.frames.at(-1);
    rows(frame.adapterProposedMotion, activeMotion);
    rows(frame.commandedMotion, activeMotion);
    if (
      !activeMotion &&
      (frame.adapterProposedMotion.length || frame.commandedMotion.length)
    )
      reject();
    subset(frame.heldIds);
    subset(frame.jointYieldIds);
    if ("assist" in frame && frame.assist) {
      rows(frame.assist);
      for (const a of frame.assist)
        if (a.source && !ids.includes(a.source)) reject();
    }
    if ("viewTasks" in frame) {
      rows(frame.viewTasks);
      for (const task of frame.viewTasks) {
        rows(task.estimate.sources);
        rows(task.estimate.excluded);
      }
    } else if (fleet === 3) reject();
  }
  for (const decision of team.decisions) rows(decision.allocations);
  for (const epoch of team.beliefEpochs) {
    rows(epoch.sensors, fleet === 2 || !shared);
    if (fleet === 3 && shared && epoch.sensors.length !== 1) reject();
    for (const sensor of epoch.sensors) {
      if ("owners" in sensor) {
        subset(sensor.owners, shared);
        if (
          !shared &&
          (sensor.owners.length !== 1 || sensor.owners[0] !== sensor.id)
        )
          reject();
      } else if (fleet === 3) reject();
    }
  }
  for (const key of [
    "holdSecondsById",
    "maxConsecutiveHoldSById",
    "blockedSecondsById",
    "ledgers",
  ]) {
    const stats = team.diagnostics[key];
    if (stats && typeof stats === "object") subset(Object.keys(stats));
  }
}
