import { DRONE, makeDrone, stepDrone } from "./drone";
import { blockerToReason, lineOfSight } from "./geometry";
import { Rng } from "./rng";
import { fovTest } from "./sensor";
import { DEFAULT_WAYPOINTS, samplePath, type XZ } from "./route";
import { SubjectAgent } from "./subject";
import { Tracker } from "./tracker";
import { makeBelief, type BeliefGrid } from "../ml/belief";
import { FeatureExtractor, type FeatureOutput } from "../ml/features";
import { LearnedSearchGuidance } from "../ml/guidance";
import type { Frame, Observation, VisibilityReason } from "./types";
import { generateWorld, type World } from "./world";

export interface SimConfig {
  seed: number;
  duration: number;
  dt: number;
  /** Destination waypoints the evasive subject is heading for (goal only; it does not follow them as a path). */
  waypoints: XZ[];
  /** Seed of the subject-policy RNG stream (separate from the sensor-noise stream, which uses `seed`). */
  subjectSeed: number;
}

export const DEFAULT_CONFIG: SimConfig = { seed: 79, duration: 75, dt: 0.05, waypoints: DEFAULT_WAYPOINTS, subjectSeed: 40 };

export interface Timeline {
  config: SimConfig;
  world: World;
  frames: Frame[];
  events: TimelineEvent[];
  /** Present only for learned-guidance runs. The Kalman default timeline never carries this key. */
  ml?: MlTimelineData;
}

/** Learned-belief record of a guided run: one entry per fixed prediction tick (every `stride` steps; null when not lost). */
export interface MlTimelineData {
  stride: number;
  beliefs: (BeliefGrid | null)[];
  /** The coarse designated start area the drone was set up with (non-exact; the learned model itself never receives it). */
  startArea: { x: number; z: number };
  guidance: { learnedChoices: number; fallbacks: number };
}

export interface MlRunOptions {
  /** Steps between model predictions (fixed simulation steps, not wall-clock). */
  stride: number;
  /** Observe the exact features handed to the model (tests / evaluation only). */
  onFeatures?: (i: number, f: FeatureOutput) => void;
}

export const ML_STRIDE_STEPS = 20; // 1.0 s at dt = 0.05

export interface PredictRequest { i: number; features: FeatureOutput }

/** How the drone is set up at t=0. "exact" is the original demo behaviour (Kalman default, unchanged); "coarse" never uses the subject's start. */
export type StartSetup = "exact" | "coarse";
/** Side of the square cells the operator's designated start area is quantised to (so the designation is never the exact start point). */
export const COARSE_AREA_M = 16;
/** Fixed approach side for the coarse setup (drone starts south of the designated area). Not derived from the route or the subject heading. */
const COARSE_APPROACH_DIR = { x: 0, z: 1 };

/**
 * Coarse designated start area: centre of the COARSE_AREA_M cell that contains the scenario's first waypoint. It is computed from the
 * scenario configuration only (never from SubjectAgent state), is deliberately NOT the exact start, and is used only to place and point
 * the drone at t=0. The learned model/feature extractor never receives it.
 */
export function scenarioStartArea(config: SimConfig): { x: number; z: number } {
  const c = (v: number) => (Math.floor(v / COARSE_AREA_M) + 0.5) * COARSE_AREA_M;
  return { x: c(config.waypoints[0][0]), z: c(config.waypoints[0][1]) };
}

export interface TimelineEvent {
  key: "LOST_VISUAL" | "SEARCH_START" | "CANOPY_LAYER" | "UNDER_CANOPY" | "FIRST_FIX" | "RECONFIRMED";
  label: string;
  t: number;
  i: number;
}

const GROVE_FROM_WP = 2, GROVE_TO_WP = 9;

export function buildWorld(config: SimConfig): World {
  // The forest is generated against the DEFAULT route so every replay shares one world,
  // even if a test swaps the walker's route afterwards.
  const route = samplePath(DEFAULT_WAYPOINTS);
  const idx = (k: number) => Math.floor((k / (DEFAULT_WAYPOINTS.length - 1)) * (route.length - 1));
  return generateWorld(config.seed, route, idx(GROVE_FROM_WP), idx(GROVE_TO_WP));
}

export function simulate(config: SimConfig = DEFAULT_CONFIG, world: World = buildWorld(config), start: StartSetup = "exact"): Timeline {
  const gen = simulateCore(config, world, start);
  const r = gen.next();
  if (!r.done) throw new Error("Kalman simulation unexpectedly requested a model prediction");
  return r.value;
}

/**
 * Learned-guidance run. `predict` is awaited at fixed simulation steps (every `stride` steps while the fix is missing), so the
 * result depends only on (config, world, model), never on wall-clock timing or call latency.
 */
export async function simulateGuided(
  config: SimConfig,
  world: World,
  predict: (f: FeatureOutput) => Promise<Float32Array>,
  opts: MlRunOptions = { stride: ML_STRIDE_STEPS },
  onProgress?: (frac: number) => void,
): Promise<Timeline> {
  const gen = simulateCore(config, world, "coarse", opts);
  const total = Math.round(config.duration / config.dt);
  let r = gen.next();
  while (!r.done) {
    onProgress?.(r.value.i / total);
    const prob = await predict(r.value.features);
    r = gen.next(prob);
  }
  return r.value;
}

function* simulateCore(config: SimConfig, world: World, start: StartSetup, ml?: MlRunOptions): Generator<PredictRequest, Timeline, Float32Array> {
  const agent = new SubjectAgent(world, config.waypoints, config.subjectSeed, config.dt);
  const rng = new Rng(config.seed ^ 0x9e3779b9); // sensor-noise stream only; the subject has its own stream
  const tracker = new Tracker();
  let aimHint: { x: number; z: number };
  let dir: { x: number; z: number };
  if (start === "coarse") {
    // Coarse setup: the drone is placed and aimed from the quantised designated area only; no read of subject state.
    aimHint = scenarioStartArea(config);
    dir = COARSE_APPROACH_DIR;
  } else {
    const s0 = agent.snapshot();
    // Scenario set-up: the operator designates the target's initial area. Only used to point the gimbal at t=0.
    aimHint = { x: s0.x, z: s0.z };
    dir = { x: Math.sin(s0.heading), z: Math.cos(s0.heading) };
  }
  const drone = makeDrone(world, { x: aimHint.x - dir.x * DRONE.followStandoff, z: aimHint.z - dir.z * DRONE.followStandoff }, aimHint);
  const extractor = ml ? new FeatureExtractor(world) : null;
  const guidance = ml ? new LearnedSearchGuidance() : undefined;
  const beliefs: (BeliefGrid | null)[] = [];

  const n = Math.round(config.duration / config.dt);
  const frames: Frame[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i * config.dt;
    const truth = agent.snapshot();
    // ---- sensing: geometry decides visibility ----
    const target = { x: truth.x, y: truth.y + DRONE.targetHeight, z: truth.z };
    const fov = fovTest(drone.pos, drone.camYaw, drone.camPitch, target);
    const blocker = lineOfSight(world, drone.pos, target);
    let visibility: VisibilityReason;
    if (!fov.inRange) visibility = "OUT_OF_RANGE";
    else if (!fov.inFov) visibility = "OUT_OF_FOV";
    else visibility = blockerToReason(blocker);
    // noise draws are consumed unconditionally so the stream does not depend on visibility
    const nx = rng.normal(), nz = rng.normal();
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
      i, t,
      subject: truth,
      drone: { x: drone.pos.x, y: drone.pos.y, z: drone.pos.z, yaw: drone.yaw, vx: drone.vel.x, vy: drone.vel.y, vz: drone.vel.z, agl: drone.pos.y - world.heightAt(drone.pos.x, drone.pos.z) },
      cam: { yaw: drone.camYaw, pitch: drone.camPitch },
      obs, visibility, track: snap, mode: drone.mode,
      viewpoint: drone.viewpoint ? { ...drone.viewpoint } : null,
    });

    // ---- learned belief: narrow observation + drone pose + known map only (never truth / visibility) ----
    if (ml && extractor && guidance) {
      extractor.push({
        t,
        obs: obs ? { t: obs.t, x: obs.x, z: obs.z, sigma: obs.sigma } : null,
        drone: { x: drone.pos.x, y: drone.pos.y, z: drone.pos.z, camYaw: drone.camYaw, camPitch: drone.camPitch },
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
    stepDrone(world, drone, snap, aimHint, t, config.dt, guidance);
    // ---- subject: reacts to a delayed/noisy view of the drone's pose at the start of this step ----
    agent.step({ x: frames[i].drone.x, y: frames[i].drone.y, z: frames[i].drone.z }, config.dt);
  }
  const tl: Timeline = { config, world, frames, events: deriveEvents(frames, world) };
  if (ml && guidance) tl.ml = { stride: ml.stride, beliefs, startArea: scenarioStartArea(config), guidance: { ...guidance.stats } };
  return tl;
}

export function canopyBands(world: World): { layerTop: number; bottom: number } {
  const g = world.trees.filter((t) => t.grove);
  const tops = g.map((t) => t.canopyY + t.canopyR - t.groundY).sort((a, b) => a - b);
  const bots = g.map((t) => t.canopyY - t.canopyR - t.groundY).sort((a, b) => a - b);
  return { layerTop: tops[Math.floor(tops.length / 2)], bottom: bots[Math.floor(bots.length * 0.1)] };
}

/** Timeline markers are derived from what happened in the frames, never scripted. */
export function deriveEvents(frames: Frame[], world: World): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  const add = (key: TimelineEvent["key"], label: string, f: Frame | undefined) => {
    if (f) ev.push({ key, label, t: f.t, i: f.i });
  };
  const { layerTop, bottom } = canopyBands(world);
  const lost = frames.find((f) => f.track.initialised && f.track.status !== "TRACKING");
  add("LOST_VISUAL", "Subject occluded", lost);
  const sFrame = frames.find((f) => f.track.status === "SEARCHING");
  add("SEARCH_START", "Search begins", sFrame);
  if (sFrame) {
    add("CANOPY_LAYER", "Enters canopy layer", frames.find((f) => f.i >= sFrame.i && f.drone.agl < layerTop));
    add("UNDER_CANOPY", "Below canopy", frames.find((f) => f.i >= sFrame.i && f.drone.agl < bottom));
    const r = frames.find((f) => f.i > sFrame.i && f.obs !== null && f.track.status === "REACQUIRING");
    add("FIRST_FIX", "Reacquired", r);
    if (r) add("RECONFIRMED", "Track confirmed", frames.find((f) => f.i > r.i && f.track.status === "TRACKING"));
  }
  return ev.sort((a, b) => a.t - b.t);
}

export interface ActionSegment {
  action: Frame["subject"]["action"];
  t0: number;
  t1: number;
  i0: number;
  i1: number;
}

/** Contiguous runs of the subject's recorded action (evaluation only; for tests and the README). */
export function subjectSegments(frames: Frame[]): ActionSegment[] {
  const out: ActionSegment[] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && last.action === f.subject.action) { last.t1 = f.t; last.i1 = f.i; }
    else out.push({ action: f.subject.action, t0: f.t, t1: f.t, i0: f.i, i1: f.i });
  }
  return out;
}
