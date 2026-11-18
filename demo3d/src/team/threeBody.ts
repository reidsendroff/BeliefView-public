/** Versioned synthetic body shared by N3 rendering, sensing and physical cover checks. No inference inputs. */
import type { Vec3 } from "../sim/types";
import type { World } from "../sim/world";
export const BODY_VERSION = "n3-articulated-body-v1";
export const BODY = {
  gaitCycleM: 1.4,
  headRadius: 0.12,
  torsoRadius: 0.16,
  pelvisRadius: 0.14,
  upperLeg: 0.45,
  lowerLeg: 0.45,
  upperArm: 0.3,
  lowerArm: 0.28,
  legRadius: 0.075,
  armRadius: 0.055,
  footRadius: 0.07,
  handRadius: 0.055,
  minPelvis: 0.15,
  maxPelvis: 1.25,
  maxSlope: Math.tan((25 * Math.PI) / 180),
} as const;
export type Posture = "standing" | "crouched" | "kneeling" | "prone";
export type PostureTransition = {
  from: Posture;
  to: Posture;
  progress: number;
};
export interface BodyInput {
  root: Vec3;
  heading: number;
  gait: number;
  speed: number;
  posture: PostureTransition;
}
export type JointId =
  | "pelvis"
  | "chest"
  | "head"
  | "shoulderL"
  | "shoulderR"
  | "elbowL"
  | "elbowR"
  | "handL"
  | "handR"
  | "hipL"
  | "hipR"
  | "kneeL"
  | "kneeR"
  | "footL"
  | "footR";
export const SAMPLE_IDS = [
  "head",
  "chest",
  "pelvis",
  "shoulderL",
  "shoulderR",
  "handL",
  "handR",
  "footL",
  "footR",
] as const;
export type SampleId = (typeof SAMPLE_IDS)[number];
export interface BodyCapsule {
  id: string;
  a: Vec3;
  b: Vec3;
  radius: number;
}
export type BodySamples = readonly [
  { id: "head"; point: Vec3 },
  { id: "chest"; point: Vec3 },
  { id: "pelvis"; point: Vec3 },
  { id: "shoulderL"; point: Vec3 },
  { id: "shoulderR"; point: Vec3 },
  { id: "handL"; point: Vec3 },
  { id: "handR"; point: Vec3 },
  { id: "footL"; point: Vec3 },
  { id: "footR"; point: Vec3 },
];
export interface BodyPose {
  joints: Record<JointId, Vec3>;
  samples: BodySamples;
  capsules: BodyCapsule[];
  groundingValid: boolean;
  invalidReason:
    null | "nonfinite" | "slope" | "reach" | "pelvis-bounds" | "support";
}
const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const scale = (a: Vec3, k: number): Vec3 => ({
  x: a.x * k,
  y: a.y * k,
  z: a.z * k,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const mix = (a: Vec3, b: Vec3, t: number) => add(a, scale(sub(b, a), t));
/** Fixed-length analytic two-link solution, with a stable explicit bend pole. */
export function twoBone(
  a: Vec3,
  end: Vec3,
  pole: Vec3,
  l1: number,
  l2: number,
) {
  const delta = sub(end, a),
    distance = length(delta),
    axis = scale(delta, 1 / (distance || 1));
  const reachable =
    distance > 1e-8 &&
    distance <= l1 + l2 + 1e-8 &&
    distance >= Math.abs(l1 - l2) - 1e-8;
  const d = Math.max(1e-8, Math.min(l1 + l2 - 1e-8, distance));
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d),
    height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  let bend = sub(sub(pole, a), scale(axis, dot(sub(pole, a), axis)));
  if (length(bend) < 1e-8)
    bend =
      Math.abs(axis.y) < 0.9
        ? sub({ x: 0, y: 1, z: 0 }, scale(axis, axis.y))
        : sub({ x: 1, y: 0, z: 0 }, scale(axis, axis.x));
  bend = scale(bend, 1 / (length(bend) || 1));
  return {
    joint: add(add(a, scale(axis, along)), scale(bend, height)),
    reachable,
  };
}
function keyPose(
  input: BodyInput,
  posture: Posture,
  ground: Pick<World, "heightAt">,
): Record<JointId, Vec3> {
  const { root, heading } = input,
    f = { x: Math.sin(heading), y: 0, z: Math.cos(heading) },
    r = { x: Math.cos(heading), y: 0, z: -Math.sin(heading) };
  const at = (side: number, forward: number, height: number): Vec3 => {
    const x = root.x + r.x * side + f.x * forward,
      z = root.z + r.z * side + f.z * forward;
    return { x, z, y: ground.heightAt(x, z) + height };
  };
  const prone = posture === "prone",
    standing = posture === "standing",
    kneeling = posture === "kneeling";
  const pelvis = at(
    0,
    0,
    prone
      ? 0.25
      : standing
        ? 0.95
        : kneeling
          ? 0.075 + Math.sqrt(BODY.upperLeg ** 2 - 0.25 ** 2)
          : 0.55,
  );
  const chest = at(
    0,
    prone ? 0.4 : standing ? 0 : 0.12,
    prone ? 0.32 : standing ? 1.5 : 0.85,
  );
  const head = at(
    0,
    prone ? 0.69 : standing ? 0 : 0.15,
    prone ? 0.35 : standing ? 1.8 : 1.1,
  );
  const joints = { pelvis, chest, head } as Record<JointId, Vec3>;
  for (const side of ["L", "R"] as const) {
    const sign = side === "L" ? -1 : 1,
      phase =
        ((input.gait / BODY.gaitCycleM) * 2 * Math.PI +
          (side === "L" ? 0 : Math.PI)) %
        (2 * Math.PI),
      moving = standing ? Math.min(1, input.speed / 0.5) : 0,
      stance = phase < Math.PI,
      fraction = (phase % Math.PI) / Math.PI,
      footForward =
        (stance ? 0.35 - 0.7 * fraction : -0.35 + 0.7 * fraction) * moving,
      footLift = stance ? 0 : Math.sin(fraction * Math.PI) * 0.15 * moving;
    const hip = add(pelvis, scale(r, sign * 0.12)),
      shoulder = add(chest, scale(r, sign * 0.2));
    const foot = at(
      sign * 0.13,
      prone
        ? -0.87
        : kneeling
          ? 0.25 - Math.sqrt(BODY.lowerLeg ** 2 - 0.005 ** 2)
          : standing
            ? footForward
            : 0.22,
      0.08 + (standing ? footLift : 0),
    );
    const hand = at(
      sign * (prone ? 0.29 : 0.3),
      prone ? 0.73 : standing ? -Math.sin(phase) * 0.15 * moving : 0.4,
      prone ? 0.1 : standing ? 0.94 : 0.65,
    );
    if (!prone) hand.y = chest.y - (standing ? 0.46 : 0.2);
    joints[("hip" + side) as JointId] = hip;
    joints[("shoulder" + side) as JointId] = shoulder;
    joints[("foot" + side) as JointId] = foot;
    joints[("hand" + side) as JointId] = hand;
    joints[("knee" + side) as JointId] = at(
      sign * 0.14,
      prone ? -0.45 : 0.65,
      prone ? 0.13 : 0.3,
    );
    joints[("elbow" + side) as JointId] = at(
      sign * 0.48,
      prone ? 0.52 : 0,
      prone ? 0.13 : standing ? 1.12 : 0.6,
    );
  }
  if (kneeling) {
    const hipYs: number[] = [];
    for (const side of ["L", "R"] as const) {
      const sign = side === "L" ? -1 : 1,
        knee = at(sign * 0.12, 0.25, BODY.legRadius);
      let lo = 0,
        hi = 0.6;
      for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2,
          foot = at(sign * 0.12, 0.25 - m, 0.08);
        if (length(sub(foot, knee)) > BODY.lowerLeg) hi = m;
        else lo = m;
      }
      const foot = at(sign * 0.12, 0.25 - (lo + hi) / 2, 0.08),
        hip = at(sign * 0.12, 0, 0);
      hip.y = knee.y + Math.sqrt(BODY.upperLeg ** 2 - 0.25 ** 2);
      joints[("hip" + side) as JointId] = hip;
      joints[("knee" + side) as JointId] = knee;
      joints[("foot" + side) as JointId] = foot;
      hipYs.push(hip.y);
    }
    joints.pelvis = { x: root.x, y: (hipYs[0] + hipYs[1]) / 2, z: root.z };
  }
  if (standing) {
    // Adapt support height before solving, keeping fixed limb lengths on downhill strides.
    let allowed = pelvis.y;
    for (const side of ["L", "R"] as const) {
      const hip = joints[("hip" + side) as JointId],
        foot = joints[("foot" + side) as JointId],
        horizontal = Math.hypot(hip.x - foot.x, hip.z - foot.z);
      allowed = Math.min(
        allowed,
        foot.y +
          Math.sqrt(
            Math.max(
              0,
              (BODY.upperLeg + BODY.lowerLeg - 0.005) ** 2 - horizontal ** 2,
            ),
          ),
      );
    }
    const lower = Math.max(0, pelvis.y - allowed);
    for (const id of [
      "pelvis",
      "chest",
      "head",
      "hipL",
      "hipR",
      "shoulderL",
      "shoulderR",
      "elbowL",
      "elbowR",
      "handL",
      "handR",
    ] as JointId[])
      joints[id] = {
        x: joints[id].x,
        y: joints[id].y - lower,
        z: joints[id].z,
      };
  }
  return joints;
}
export function bodyPose(
  input: BodyInput,
  ground: Pick<World, "heightAt">,
): BodyPose {
  const inputs = [
    input.root.x,
    input.root.y,
    input.root.z,
    input.heading,
    input.gait,
    input.speed,
    input.posture.progress,
  ];
  if (
    inputs.some((v) => !Number.isFinite(v)) ||
    input.posture.progress < 0 ||
    input.posture.progress > 1 ||
    !["standing", "crouched", "kneeling", "prone"].includes(
      input.posture.from,
    ) ||
    !["standing", "crouched", "kneeling", "prone"].includes(input.posture.to)
  ) {
    const safe = bodyPose(
      {
        root: { x: 0, y: 0, z: 0 },
        heading: 0,
        gait: 0,
        speed: 0,
        posture: { from: "standing", to: "standing", progress: 1 },
      },
      { heightAt: () => 0 },
    );
    return { ...safe, groundingValid: false, invalidReason: "nonfinite" };
  }
  const t = Math.max(0, Math.min(1, input.posture.progress)),
    a = keyPose(input, input.posture.from, ground),
    b = keyPose(input, input.posture.to, ground),
    j = {} as Record<JointId, Vec3>;
  for (const id of Object.keys(a) as JointId[]) j[id] = mix(a[id], b[id], t);
  let invalid: BodyPose["invalidReason"] = null;
  for (const side of ["L", "R"] as const) {
    for (const [start, middle, end, l1, l2] of [
      ["hip", "knee", "foot", BODY.upperLeg, BODY.lowerLeg],
      ["shoulder", "elbow", "hand", BODY.upperArm, BODY.lowerArm],
    ] as const) {
      const mid = (middle + side) as JointId,
        pole = {
          x: j[mid].x,
          y:
            middle === "knee"
              ? (() => {
                  const kneel =
                      (input.posture.from === "kneeling" ? 1 - t : 0) +
                      (input.posture.to === "kneeling" ? t : 0),
                    upper =
                      Math.max(
                        j[(start + side) as JointId].y,
                        j[(end + side) as JointId].y,
                      ) + 0.6;
                  return upper * (1 - kneel) + j[mid].y * kneel;
                })()
              : j[mid].y,
          z: j[mid].z,
        };
      let sol = twoBone(
        j[(start + side) as JointId],
        j[(end + side) as JointId],
        pole,
        l1,
        l2,
      );
      const radius = middle === "knee" ? BODY.legRadius : BODY.armRadius;
      const supported = (q: Vec3) =>
        q.y - radius >= ground.heightAt(q.x, q.z) - 1e-7;
      if (!supported(sol.joint)) {
        const up = {
          x: pole.x,
          y:
            Math.max(
              j[(start + side) as JointId].y,
              j[(end + side) as JointId].y,
            ) + 1,
          z: pole.z,
        };
        const solve = (blend: number) =>
          twoBone(
            j[(start + side) as JointId],
            j[(end + side) as JointId],
            mix(pole, up, blend),
            l1,
            l2,
          );
        if (supported(solve(1).joint)) {
          let lo = 0,
            hi = 1;
          for (let k = 0; k < 24; k++) {
            const m = (lo + hi) / 2;
            if (supported(solve(m).joint)) hi = m;
            else lo = m;
          }
          sol = solve(hi);
        }
      }
      j[mid] = sol.joint;
      if (!sol.reachable) invalid = "reach";
    }
  }
  const capsules: BodyCapsule[] = [
    { id: "torso", a: j.pelvis, b: j.chest, radius: BODY.torsoRadius },
    { id: "pelvis", a: j.pelvis, b: j.pelvis, radius: BODY.pelvisRadius },
    { id: "head", a: j.head, b: j.head, radius: BODY.headRadius },
    { id: "neck", a: j.chest, b: j.head, radius: 0.07 },
  ];
  for (const side of ["L", "R"] as const)
    for (const [name, start, end, radius] of [
      ["upperLeg", "hip", "knee", BODY.legRadius],
      ["lowerLeg", "knee", "foot", BODY.legRadius],
      ["upperArm", "shoulder", "elbow", BODY.armRadius],
      ["lowerArm", "elbow", "hand", BODY.armRadius],
      ["foot", "foot", "foot", BODY.footRadius],
      ["hand", "hand", "hand", BODY.handRadius],
    ] as const)
      capsules.push({
        id: name + side,
        a: j[(start + side) as JointId],
        b: j[(end + side) as JointId],
        radius,
      });
  const samples = SAMPLE_IDS.map((id) => ({
    id,
    point:
      id === "head"
        ? add(j.head, { x: 0, y: BODY.headRadius, z: 0 })
        : { x: j[id].x, y: j[id].y, z: j[id].z },
  })) as unknown as BodySamples;
  const g = ground.heightAt(input.root.x, input.root.z),
    pelvis = j.pelvis;
  if (Math.abs(input.root.y - g) > 0.005) invalid = "support";
  if (
    pelvis.x !== input.root.x ||
    pelvis.z !== input.root.z ||
    pelvis.y < g + BODY.minPelvis - 1e-9 ||
    pelvis.y > g + BODY.maxPelvis + 1e-9
  )
    invalid = "pelvis-bounds";
  const dx =
      (ground.heightAt(input.root.x + 0.1, input.root.z) -
        ground.heightAt(input.root.x - 0.1, input.root.z)) /
      0.2,
    dz =
      (ground.heightAt(input.root.x, input.root.z + 0.1) -
        ground.heightAt(input.root.x, input.root.z - 0.1)) /
      0.2;
  if (Math.hypot(dx, dz) > BODY.maxSlope) invalid = "slope";
  for (const c of capsules)
    for (let k = 0; k <= 4; k++) {
      const p = mix(c.a, c.b, k / 4);
      if (p.y - c.radius < ground.heightAt(p.x, p.z) - 0.005)
        invalid = "support";
    }
  if (Object.values(j).some((p) => ![p.x, p.y, p.z].every(Number.isFinite))) {
    const safe = bodyPose(
      {
        root: { x: 0, y: 0, z: 0 },
        heading: 0,
        gait: 0,
        speed: 0,
        posture: { from: "standing", to: "standing", progress: 1 },
      },
      { heightAt: () => 0 },
    );
    return { ...safe, groundingValid: false, invalidReason: "nonfinite" };
  }
  return {
    joints: j,
    samples,
    capsules,
    groundingValid: invalid === null,
    invalidReason: invalid,
  };
}
