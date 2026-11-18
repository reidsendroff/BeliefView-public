/** Simulation-side scenario generation. Public map is generated BEFORE, independently of hidden routes. */
import { assertNotReserved } from "./seeds";
import { DEFAULT_CONFIG, buildWorld } from "../sim/simulate";
import {
  buildRichWorld,
  inWater,
  subjectNavigationWorld,
  drySubjectGoals,
} from "../sim/richWorld";
import { RichSubjectAgent } from "../sim/richSubject";
import { makeDrone, type DroneState } from "../sim/drone";
import { lineOfSight } from "../sim/geometry";
import { fovTest } from "../sim/sensor";
import { Rng } from "../sim/rng";
import type { World } from "../sim/world";
import type { SubjectSnapshot } from "../sim/subject";
import {
  INITIAL_REGION,
  TEAM,
  type PublicRegion,
  type SensorId,
} from "./types";
export interface PublicScenario {
  world: World;
  prior: PublicRegion;
  starts: { id: SensorId; x: number; z: number }[];
}
export interface HiddenScenario {
  subjectSeed: number;
  goals: [number, number][];
}
export interface TeamScenario {
  public: PublicScenario;
  hidden: HiddenScenario;
  generation: {
    attempts: number;
    initializationS: number;
    subjectSeed: number;
    worldSeed: number;
    family: string;
  };
}
export function buildPublicScenario(
  seed: number,
  family: "original" | "rich",
): PublicScenario {
  assertNotReserved(seed);
  const config = { ...DEFAULT_CONFIG, seed };
  return {
    world: family === "rich" ? buildRichWorld(config) : buildWorld(config),
    prior: { ...INITIAL_REGION },
    starts: [
      { id: "A", x: -42, z: 56 },
      { id: "B", x: 42, z: 56 },
    ],
  };
}
export function initialDrones(p: PublicScenario) {
  const aim = {
    x: (p.prior.minX + p.prior.maxX) / 2,
    z: (p.prior.minZ + p.prior.maxZ) / 2,
  };
  return p.starts.map((s) => ({ id: s.id, state: makeDrone(p.world, s, aim) }));
}
export function canSense(
  world: World,
  d: DroneState,
  s: SubjectSnapshot,
): boolean {
  const point = { x: s.x, z: s.z, y: s.y + 1.3 - 0.65 * s.crouch },
    f = fovTest(d.pos, d.camYaw, d.camPitch, point);
  return f.inFov && f.inRange && lineOfSight(world, d.pos, point) === "NONE";
}
export function nearestDrone(
  drones: readonly { id: SensorId; state: DroneState }[],
  s: { x: number; z: number },
) {
  return [...drones].sort(
    (a, b) =>
      Math.hypot(a.state.pos.x - s.x, a.state.pos.z - s.z) -
        Math.hypot(b.state.pos.x - s.x, b.state.pos.z - s.z) ||
      a.id.localeCompare(b.id),
  )[0].state.pos;
}
export function makeSubject(p: PublicScenario, h: HiddenScenario) {
  return new RichSubjectAgent(
    subjectNavigationWorld(p.world),
    drySubjectGoals(p.world, h.goals),
    h.subjectSeed,
    TEAM.dt,
  );
}
export function generateTeamScenario(
  worldSeed: number,
  subjectSeed: number,
  family: "original" | "rich",
): TeamScenario {
  assertNotReserved(worldSeed, subjectSeed);
  const p = buildPublicScenario(worldSeed, family),
    rng = new Rng(subjectSeed),
    drones = initialDrones(p),
    w = p.world;
  const valid = (x: number, z: number) =>
    !inWater(w, x, z, 0.6) &&
    !w.trees.some(
      (t) => t.trunkR > 0 && Math.hypot(t.x - x, t.z - z) < t.trunkR + 0.7,
    );
  for (let attempt = 1; attempt <= 100; attempt++) {
    const x = rng.range(p.prior.minX, p.prior.maxX),
      z = rng.range(p.prior.minZ, p.prior.maxZ);
    if (!valid(x, z)) continue;
    const goals: [number, number][] = [[x, z]];
    for (let tries = 0; goals.length < 5 && tries < 200; tries++) {
      const gx = rng.range(-65, 65),
        gz = rng.range(-65, 65);
      if (valid(gx, gz)) goals.push([gx, gz]);
    }
    if (goals.length < 5) continue;
    const hidden = { goals, subjectSeed },
      agent = makeSubject(p, hidden);
    let hiddenPrefix = true;
    // Sensors are genuinely on during a common stationary initialization prefix, identical across arms.
    for (let i = 0; i <= Math.round(TEAM.initializationS / TEAM.dt); i++) {
      const s = agent.snapshot();
      if (drones.some((d) => canSense(w, d.state, s))) {
        hiddenPrefix = false;
        break;
      }
      agent.step(nearestDrone(drones, s), TEAM.dt);
    }
    if (hiddenPrefix)
      return {
        public: p,
        hidden,
        generation: {
          attempts: attempt,
          initializationS: TEAM.initializationS,
          subjectSeed,
          worldSeed,
          family,
        },
      };
  }
  throw new Error(
    `No admissible hidden initialization for world ${worldSeed}, subject ${subjectSeed}; report this failure, do not replace the seed`,
  );
}
