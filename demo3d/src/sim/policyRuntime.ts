/** Versioned runtime for active search/rich terrain. Original simulator remains frozen and testable byte-for-byte. */
import { DRONE, makeDrone, stepDrone } from "./drone";
import { blockerToReason, lineOfSight } from "./geometry";
import { Rng } from "./rng";
import { fovTest } from "./sensor";
import { SubjectAgent } from "./subject";
import { RichSubjectAgent } from "./richSubject";
import { Tracker } from "./tracker";
import {
  isRichWorld,
  subjectNavigationWorld,
  drySubjectGoals,
} from "./richWorld";
import { makeBelief, type BeliefGrid } from "../ml/belief";
import { FeatureExtractor, type FeatureOutput } from "../ml/features";
import { LearnedSearchGuidance } from "../ml/guidance";
import {
  ActiveSearchGuidance,
  ACTIVE_OPTIONS,
  type ActiveOptions,
} from "../ml/activeGuidance";
import type { Frame, Observation, VisibilityReason } from "./types";
import type { World } from "./world";
import {
  deriveEvents,
  ML_STRIDE_STEPS,
  scenarioStartArea,
  type SimConfig,
  type Timeline,
  type PredictRequest,
} from "./simulate";
export type PolicyChoice = "kalman" | "baseline" | "active";
export interface PolicyDecision {
  i: number;
  t: number;
  goal: { x: number; z: number };
  waypoint: { x: number; z: number };
  visibleMass: number;
  novelUtility: number;
  routeMeters: number;
  path: { x: number; z: number }[];
}
export interface PolicyTimeline extends Timeline {
  policy?: {
    version: PolicyChoice;
    terrain: string;
    decisions: PolicyDecision[];
    fallbacks: { i: number; t: number }[];
    stats: ActiveSearchGuidance["stats"] | null;
  };
}
export async function simulatePolicy(
  config: SimConfig,
  world: World,
  policy: PolicyChoice,
  predict: (f: FeatureOutput) => Promise<Float32Array>,
  options: ActiveOptions = ACTIVE_OPTIONS,
  onFeatures?: (i: number, f: FeatureOutput) => void,
  onProgress?: (frac: number) => void,
): Promise<PolicyTimeline> {
  const gen = policyCore(config, world, policy, options, onFeatures);
  let r = gen.next();
  while (!r.done) {
    onProgress?.(r.value.i / Math.round(config.duration / config.dt));
    r = gen.next(await predict(r.value.features));
  }
  return r.value;
}
function* policyCore(
  config: SimConfig,
  world: World,
  policy: PolicyChoice,
  options: ActiveOptions,
  onFeatures?: (i: number, f: FeatureOutput) => void,
): Generator<PredictRequest, Timeline, Float32Array> {
  const rich = isRichWorld(world);
  const ml =
    policy === "kalman" ? undefined : { stride: ML_STRIDE_STEPS, onFeatures };
  const agent = rich
    ? new RichSubjectAgent(
        subjectNavigationWorld(world),
        drySubjectGoals(world, config.waypoints),
        config.subjectSeed,
        config.dt,
      )
    : new SubjectAgent(world, config.waypoints, config.subjectSeed, config.dt);
  const rng = new Rng(config.seed ^ 0x9e3779b9); // sensor-noise stream only; the subject has its own stream
  const tracker = new Tracker();
  const aimHint = scenarioStartArea(config),
    dir = { x: 0, z: 1 };
  const drone = makeDrone(
    world,
    {
      x: aimHint.x - dir.x * DRONE.followStandoff,
      z: aimHint.z - dir.z * DRONE.followStandoff,
    },
    aimHint,
  );
  const extractor = ml ? new FeatureExtractor(world) : null;
  const guidance = ml
    ? policy === "active"
      ? new ActiveSearchGuidance(world, options, rich ? [1.3, 0.65] : [1.3])
      : new LearnedSearchGuidance()
    : undefined;
  const decisions: PolicyDecision[] = [],
    fallbacks: { i: number; t: number }[] = [];
  const beliefs: (BeliefGrid | null)[] = [];

  const n = Math.round(config.duration / config.dt);
  const frames: Frame[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i * config.dt;
    const truth = agent.snapshot();
    // ---- sensing: geometry decides visibility ----
    const target = {
      x: truth.x,
      y: truth.y + (rich ? 1.3 - 0.65 * truth.crouch : DRONE.targetHeight),
      z: truth.z,
    };
    const fov = fovTest(drone.pos, drone.camYaw, drone.camPitch, target);
    const blocker = lineOfSight(world, drone.pos, target);
    let visibility: VisibilityReason;
    if (!fov.inRange) visibility = "OUT_OF_RANGE";
    else if (!fov.inFov) visibility = "OUT_OF_FOV";
    else visibility = blockerToReason(blocker);
    // noise draws are consumed unconditionally so the stream does not depend on visibility
    const nx = rng.normal(),
      nz = rng.normal();
    let obs: Observation | null = null;
    if (visibility === "VISIBLE") {
      const sigma = 0.4 + 0.02 * fov.range;
      obs = { t, x: truth.x + nx * sigma, z: truth.z + nz * sigma, sigma };
    }
    // ---- tracker: observations only ----
    if (i > 0) tracker.predict(config.dt);
    if (obs) tracker.update(obs);
    const snap = tracker.snapshot();

    frames.push({
      i,
      t,
      subject: truth,
      drone: {
        x: drone.pos.x,
        y: drone.pos.y,
        z: drone.pos.z,
        yaw: drone.yaw,
        vx: drone.vel.x,
        vy: drone.vel.y,
        vz: drone.vel.z,
        agl: drone.pos.y - world.heightAt(drone.pos.x, drone.pos.z),
      },
      cam: { yaw: drone.camYaw, pitch: drone.camPitch },
      obs,
      visibility,
      track: snap,
      mode: drone.mode,
      viewpoint: drone.viewpoint ? { ...drone.viewpoint } : null,
    });

    // ---- learned belief: narrow observation + drone pose + known map only (never truth / visibility) ----
    if (ml && extractor && guidance) {
      extractor.push({
        t,
        obs: obs ? { t: obs.t, x: obs.x, z: obs.z, sigma: obs.sigma } : null,
        drone: {
          x: drone.pos.x,
          y: drone.pos.y,
          z: drone.pos.z,
          camYaw: drone.camYaw,
          camPitch: drone.camPitch,
        },
      });
      if (guidance instanceof ActiveSearchGuidance)
        guidance.observe({
          t,
          obs: obs ? { t: obs.t, x: obs.x, z: obs.z, sigma: obs.sigma } : null,
          drone: {
            x: drone.pos.x,
            y: drone.pos.y,
            z: drone.pos.z,
            camYaw: drone.camYaw,
            camPitch: drone.camPitch,
          },
        });
      if (i % ml.stride === 0) {
        let belief: BeliefGrid | null = null;
        if (extractor.lost()) {
          const features = extractor.extract();
          ml.onFeatures?.(i, features);
          const prob = yield { i, features };
          belief = makeBelief(i, features, prob);
        }
        beliefs[i / ml.stride] = belief;
        guidance.setBelief(belief);
      }
    }

    // ---- guidance: belief only ----
    const prior =
      guidance instanceof ActiveSearchGuidance ? guidance.lastDecision : null;
    const priorFallbacks =
      guidance instanceof ActiveSearchGuidance ? guidance.stats.fallbacks : 0;
    stepDrone(world, drone, snap, aimHint, t, config.dt, guidance);
    if (
      guidance instanceof ActiveSearchGuidance &&
      guidance.stats.fallbacks > priorFallbacks
    )
      fallbacks.push({ i, t });
    if (
      guidance instanceof ActiveSearchGuidance &&
      guidance.lastDecision &&
      guidance.lastDecision !== prior
    )
      decisions.push({ i, t, ...guidance.lastDecision });
    // ---- subject: reacts to a delayed/noisy view of the drone's pose at the start of this step ----
    agent.step(
      { x: frames[i].drone.x, y: frames[i].drone.y, z: frames[i].drone.z },
      config.dt,
    );
  }
  const tl: Timeline = {
    config,
    world,
    frames,
    events: deriveEvents(frames, world),
  };
  if (ml && guidance)
    tl.ml = {
      stride: ml.stride,
      beliefs,
      startArea: scenarioStartArea(config),
      guidance: { ...guidance.stats },
    };
  (tl as PolicyTimeline).policy = {
    version: policy,
    terrain: rich ? "rich-v1" : "original",
    decisions,
    fallbacks,
    stats:
      guidance instanceof ActiveSearchGuidance ? { ...guidance.stats } : null,
  };
  return tl;
}
