/** Separate N3 simulation-side admission. Public map/start choices never inspect hidden routes. */
import { Rng } from "../sim/rng";
import { createThreeController } from "./threeDrone";
import { ThreeGeometry } from "./threeGeometry";
import { buildThreeRichWorld, wrapThreeOriginalWorld } from "./threeWorld";
import { ThreeSubjectAgent } from "./threeSubject";
import { bodyDetection } from "./threeSensing";
import { bodyPose } from "./threeBody";
import { ThreeGroundNavigation } from "./threeGroundNavigation";
import { inWater } from "../sim/richWorld";
import {
  buildPublicScenario,
  type PublicScenario,
  type TeamScenario,
} from "./scenario";
import { clearanceState } from "./clearance";
import { assertNotReserved } from "./seeds";
import { TEAM, type SensorId } from "./types";
import { NOISE_SALT } from "./threeConstants";
export function threeNoise(seed: number, frame: number, id: SensorId) {
  const rng = new Rng(
    (seed ^ Math.imul(frame + 1, 0x45d9f3b) ^ NOISE_SALT[id]) >>> 0,
  );
  return { x: rng.normal(), z: rng.normal() };
}
export function buildThreePublicScenario(
  seed: number,
  family: "original" | "rich",
): PublicScenario {
  assertNotReserved(seed);
  const old = buildPublicScenario(seed, family),
    base = {
      ...old,
      world:
        family === "rich"
          ? buildThreeRichWorld(
              seed,
              old.world as import("../sim/richWorld").RichWorld,
            )
          : wrapThreeOriginalWorld(old.world),
    },
    geometry = new ThreeGeometry(base.world),
    { makeDrone } = createThreeController(geometry),
    aim = { x: 0, z: 12 };
  const candidates = [{ x: 0, z: -56 }];
  for (const r of [3, 6, 9, 12])
    for (let k = 0; k < 16; k++)
      candidates.push({
        x: r * Math.sin((k * Math.PI) / 8),
        z: -56 + r * Math.cos((k * Math.PI) / 8),
      });
  const start = candidates.find((p) => {
    const state = makeDrone(base.world, p, aim),
      c = clearanceState(base.world, state.pos, 0, geometry);
    return (
      c.physicalValid &&
      c.totalDeficit <= 1e-6 &&
      base.starts.every((s) => Math.hypot(s.x - p.x, s.z - p.z) >= 8)
    );
  });
  if (!start)
    throw Error("No valid public Drone C start; scenario generation failed");
  const result = {
    world: base.world,
    prior: base.prior,
    starts: [...base.starts, { id: "C" as const, x: start.x, z: start.z }],
  };
  const drones = initialThreeDrones(result);
  for (const d of drones) {
    const c = clearanceState(result.world, d.state.pos, 0, geometry);
    if (!c.physicalValid || c.totalDeficit > 1e-6)
      throw Error("Invalid three-drone physical start: " + d.id);
  }
  return result;
}
export function generateThreeScenario(
  worldSeed: number,
  subjectSeed: number,
  family: "original" | "rich",
): TeamScenario {
  assertNotReserved(worldSeed, subjectSeed);
  const p = buildThreePublicScenario(worldSeed, family),
    rng = new Rng(subjectSeed),
    drones = initialThreeDrones(p),
    w = p.world,
    geometry = new ThreeGeometry(w),
    groundNav = new ThreeGroundNavigation(geometry);
  const valid = (x: number, z: number) =>
    !inWater(w, x, z, 0.6) &&
    groundNav.free(x, z) &&
    geometry.bodyValid(
      bodyPose(
        {
          root: { x, y: w.heightAt(x, z), z },
          heading: 0,
          gait: 0,
          speed: 0,
          posture: { from: "standing", to: "standing", progress: 1 },
        },
        w,
      ),
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
      agent = new ThreeSubjectAgent(
        w as import("./threeGeometry").ThreeWorld,
        hidden.goals,
        hidden.subjectSeed,
      );
    let admitted = true;
    for (let i = 0; i <= Math.round(TEAM.initializationS / TEAM.dt); i++) {
      const s = agent.snapshot();
      if (
        drones.some((d) => bodyDetection(geometry, d.state, s.body).detected)
      ) {
        admitted = false;
        break;
      }
      agent.step(
        drones.map((d) => ({
          id: d.id,
          position: { x: d.state.pos.x, y: d.state.pos.y, z: d.state.pos.z },
        })),
        TEAM.dt,
      );
    }
    if (admitted)
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
  throw Error(
    `No admissible three-drone initialization for world ${worldSeed}, subject ${subjectSeed}; retain the failed seed`,
  );
}

export function initialThreeDrones(p: PublicScenario) {
  const geometry = new ThreeGeometry(p.world),
    { makeDrone } = createThreeController(geometry),
    aim = {
      x: (p.prior.minX + p.prior.maxX) / 2,
      z: (p.prior.minZ + p.prior.maxZ) / 2,
    };
  return p.starts.map((s) => ({ id: s.id, state: makeDrone(p.world, s, aim) }));
}
