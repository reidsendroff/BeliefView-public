# Proposed N3 geometry/body ownership contract

Draft local interface artifact for Claude/Codex plan approval. No product code yet. Lead owns these pure interfaces and implementations; child consumes them. Type names may be refined mechanically before the first fixture freeze, but semantics require review if changed.

```ts
type V3 = Readonly<{ x: number; y: number; z: number }>;
type Plane = Readonly<{ normal: V3; offset: number }>; // inside: n dot p <= offset, unit n
type ConvexSolid = Readonly<{
  id: string; objectId: string; kind: "boulder" | "log";
  planes: readonly Plane[]; vertices: readonly V3[];
  faces: readonly (readonly number[])[];
  bounds: Readonly<{ min: V3; max: V3 }>;
}>;
// Intersect plane triples, deduplicate vertices, order each planar face and validate closed convex volume.
function convexFromPlanes(meta: Pick<ConvexSolid,"id"|"objectId"|"kind">,
  planes: readonly Plane[]): ConvexSolid;

type N3CoverObject = Readonly<{
  id: string; kind: "tree" | "boulder" | "log" | "bush" | "leaf-pile";
  x: number; z: number; radius: number; length: number; yaw: number;
  treeIndices: readonly number[]; solidIds: readonly string[];
}>;
type ThreeWorld = World & {
  n3WorldVersion: string; n3Solids: readonly ConvexSolid[];
  n3Covers: readonly N3CoverObject[];
};
```

The new rich builder retains terrainFamily="rich-v1" and the identical heightAt function from its seeded base, adding n3WorldVersion to identify changed opaque geometry. It does not use hidden subject route/spawn. Original-family N3 wraps the unchanged map with an empty convex list and grouped legacy objects. World fingerprint includes the version and all normalized plane/vertex/face/group data. Old two-drone fingerprint object shape is unchanged.

The provider is bound to one world and has no hidden subject/drone state. `lineOfSight(a,b)` includes old tree/terrain plus convex geometry; `projectClear(p,margin,minAgl)` includes all solids and returns explicit success/deficit data; `extraPhysicalMotion(a,b)` and `extraValidMotion(a,b,margin)` are the extra-solid intersection used by optional legacy clearance adapters; `extraClearance(p,margin)` returns signed minimum and total deficit; `escapeDirections(p)` returns bounded convex normals. `visiblePelvisColumn(camera,groundRoot)` is the sufficient public negative-evidence certificate. `bodyValid(pose)` checks dry/support/opaque-body constraints, and `bodySweepValid(from,to)` checks bounded transition subdivision. Consumers must not infer success from a projection's changed flag alone.

```ts
type Posture = "standing" | "crouched" | "kneeling" | "prone";
type PostureTransition = Readonly<{ from: Posture; to: Posture; progress: number }>;
type BodyInput = Readonly<{
  root: V3; heading: number; gait: number; speed: number;
  posture: PostureTransition;
}>;
type JointId = "pelvis" | "chest" | "head" |
  "shoulderL" | "shoulderR" | "elbowL" | "elbowR" | "handL" | "handR" |
  "hipL" | "hipR" | "kneeL" | "kneeR" | "footL" | "footR";
type SampleId = "head" | "chest" | "pelvis" | "shoulderL" | "shoulderR" |
  "handL" | "handR" | "footL" | "footR";
type BodyPose = Readonly<{
  joints: Readonly<Record<JointId,V3>>;
  samples: readonly [
    { id: "head"; point: V3 }, { id: "chest"; point: V3 }, { id: "pelvis"; point: V3 },
    { id: "shoulderL"; point: V3 }, { id: "shoulderR"; point: V3 },
    { id: "handL"; point: V3 }, { id: "handR"; point: V3 },
    { id: "footL"; point: V3 }, { id: "footR"; point: V3 }
  ];
  capsules: readonly Readonly<{ id: string; a: V3; b: V3; radius: number }>[];
  groundingValid: boolean;
  invalidReason: null | "nonfinite" | "slope" | "reach" | "pelvis-bounds" | "support";
}>;
function bodyPose(input: BodyInput, ground: Pick<World,"heightAt">): BodyPose;
```

Pelvis is always exactly root.x/root.z and ground(root)+[0.15,1.25] m for valid poses, including animation and transition. This is an enforced invariant needed for the public visibility certificate, not an assumption copied from true posture. Detection samples are exactly the nine named samples above in stable order. The head sample is at the upper head/cap surface, 0.12 m above the head joint, not its center. Proposed standing/crouched/prone joint heights1.80/1.10/0.35 m therefore imply top samples1.92/1.22/0.47 m. Foot/hand support joint centers sit at least their capsule radius above terrain (foot0.07 m, hand0.055 m); the0.03 m sample lift is a minimum, never permission for capsule penetration. Sample offsets are derived from the same rendered capsule/head dimensions. Support/contact sample centers are at least0.03m above terrain. Capsule radii model visible limb thickness and must fit the rendered mesh. Fixed limb lengths and deterministic bend poles prevent knee/elbow flips. Invalid grounding returns a finite pose plus groundingValid=false; callers refuse transitions rather than teleporting. The renderer cannot alter solved joint positions.

New N3 snapshot retains common root fields needed by existing timeline interpolation but adds `subjectVersion`, `body: BodyInput`, `behavior`, `coverObjectId: string|null`, and evaluation-only per-ID degraded cues/route diagnostics. It never repurposes legacy integer `cover` as a string object ID. Stage explicitly branches on N3 snapshot/version and uses bodyPose; old snapshots keep old rig. No subject/body fields enter TeamBelief, ThreePlanner, ThreeEstimate or the evidence ledger.

Cross-component pre-forest fixture: one asymmetric convex boulder blocks the actual nine-sample sensor, blocks the public pelvis column, changes candidate LOS, rejects a crossing navigation edge, rejects actual motion and body penetration, and yields mesh faces satisfying the exact same planes. A neighboring open gap stays traversable/visible. Renderer fixture uses the same serialized solid and body object as numerical tests.
