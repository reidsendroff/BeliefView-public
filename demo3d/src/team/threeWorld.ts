/** Public-seed-only N3 forest. Meshes and physics consume the same convex records. */
import { DEFAULT_CONFIG } from "../sim/simulate";
import {
  buildRichWorld,
  isCoverPrimitive,
  isRichWorld,
  inWater,
  type RichTree,
  type RichWorld,
  type CoverObject,
} from "../sim/richWorld";
import { distToPolyline } from "../sim/route";
import { Rng } from "../sim/rng";
import type { World } from "../sim/world";
import {
  convexFromPlanes,
  type ConvexSolid,
  type Plane,
  type N3CoverObject,
  type ThreeWorld,
} from "./threeGeometry";
export const THREE_WORLD_VERSION = "n3-physical-forest-v1";
export const FOREST = {
  largeBoulders: 16,
  boulderRadiusMin: 1.4,
  boulderRadiusMax: 3,
  boulderHeightMin: 1.5,
  boulderHeightMax: 3.5,
  matureFraction: 0.11,
  matureRadiusMin: 1.1,
  matureRadiusMax: 1.7,
  rockBottom: -16,
} as const;
export function isThreeWorld(world: World): world is ThreeWorld {
  return "n3WorldVersion" in world;
}
function treeGroups(world: World): N3CoverObject[] {
  return world.trees.flatMap((t, i) =>
    t.trunkR > 0 && !isCoverPrimitive(t)
      ? [
          {
            id: `tree-${i}`,
            kind: "tree" as const,
            x: t.x,
            z: t.z,
            radius: t.trunkR,
            length: 0,
            yaw: 0,
            treeIndices: [i],
            solidIds: [],
          },
        ]
      : [],
  );
}
export function wrapThreeOriginalWorld(world: World): ThreeWorld {
  const groups = treeGroups(world);
  if (isRichWorld(world))
    throw Error(
      "Original wrapper requires original terrain; use buildThreeRichWorld for rich terrain",
    );
  return {
    seed: world.seed,
    half: world.half,
    trees: world.trees,
    rocks: world.rocks,
    heightAt: world.heightAt,
    n3WorldVersion: "n3-original-static-v1",
    n3Solids: [],
    n3Covers: groups,
  };
}
export function makeBoulder(
  id: string,
  x: number,
  z: number,
  ground: number,
  radius: number,
  height: number,
  rng: Rng,
): ConvexSolid {
  const planes: Plane[] = [];
  const local = (nx: number, ny: number, nz: number, d: number) =>
    planes.push({
      normal: { x: nx, y: ny, z: nz },
      offset: d + nx * x + ny * ground + nz * z,
    });
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 + rng.range(-0.08, 0.08);
    local(
      Math.cos(a),
      rng.range(0.01, 0.07),
      Math.sin(a),
      radius * rng.range(0.88, 1.05),
    );
  }
  // Horizontal support and bevel planes bound the deliberately conservative inflated hull.
  for (const [nx, nz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ])
    local(nx, 0, nz, radius * 1.08);
  local(rng.range(-0.2, 0.2), 1, rng.range(-0.2, 0.2), height);
  local(0, 1, 0, height * 1.08);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + 0.4;
    local(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55, height + radius * 0.28);
  }
  planes.push({ normal: { x: 0, y: -1, z: 0 }, offset: -FOREST.rockBottom });
  return convexFromPlanes({ id, objectId: id, kind: "boulder" }, planes);
}
export function makeLog(
  id: string,
  x: number,
  z: number,
  ground: number,
  radius: number,
  length: number,
  yaw: number,
): ConvexSolid {
  const f = { x: Math.sin(yaw), z: Math.cos(yaw) },
    r = { x: Math.cos(yaw), z: -Math.sin(yaw) },
    cy = ground + radius * 0.65,
    planes: Plane[] = [];
  for (let k = 0; k < 10; k++) {
    const a = ((k + 0.5) * Math.PI) / 5,
      n = { x: r.x * Math.cos(a), y: Math.sin(a), z: r.z * Math.cos(a) };
    planes.push({
      normal: n,
      offset: n.x * x + n.y * cy + n.z * z + radius * Math.cos(Math.PI / 10),
    });
  }
  for (const sign of [-1, 1])
    planes.push({
      normal: { x: f.x * sign, y: 0, z: f.z * sign },
      offset: sign * (f.x * x + f.z * z) + length / 2,
    });
  return convexFromPlanes({ id, objectId: id, kind: "log" }, planes);
}
export function buildThreeRichWorld(
  seed: number,
  base: RichWorld = buildRichWorld({ ...DEFAULT_CONFIG, seed }),
): ThreeWorld & RichWorld {
  if (base.seed !== seed) throw Error("N3 public base seed mismatch");
  const rng = new Rng(seed ^ 0x7193b6a1),
    solids: ConvexSolid[] = [],
    groups: N3CoverObject[] = [],
    oldToNew = new Map<number, number>();
  const publicRoute = DEFAULT_CONFIG.waypoints;
  const eligible = base.covers
    .filter(
      (c) =>
        c.kind === "boulder" &&
        distToPolyline(publicRoute, c.x, c.z) > 3.8 &&
        Math.abs(c.x) < 75 &&
        Math.abs(c.z) < 75,
    )
    .sort((a, b) => b.radius - a.radius || a.id - b.id)
    .slice(0, FOREST.largeBoulders);
  const replaced = new Set(eligible.map((c) => c.id));
  const trees: RichTree[] = [];
  base.trees.forEach((t, i) => {
    if (
      isCoverPrimitive(t) &&
      (t.coverKind === "log" || replaced.has(t.coverId))
    )
      return;
    if ((t as RichTree).foliageOnly) return;
    const copy = { ...t } as RichTree;
    if (!isCoverPrimitive(copy) && copy.trunkR > 0) {
      const desired = rng.range(FOREST.matureRadiusMin, FOREST.matureRadiusMax);
      if (
        rng.next() < FOREST.matureFraction &&
        distToPolyline(publicRoute, copy.x, copy.z) > desired + 2.2 &&
        !inWater(base, copy.x, copy.z, desired + 1) &&
        !base.trees.some(
          (other, j) =>
            j !== i &&
            other.trunkR > 0 &&
            !isCoverPrimitive(other) &&
            Math.hypot(other.x - copy.x, other.z - copy.z) <
              desired + other.trunkR + 0.8,
        )
      )
        copy.trunkR = desired;
      if (copy.evergreen) {
        copy.canopyR = rng.range(1.45, 1.85);
        copy.canopyY = copy.groundY + rng.range(3.5, 4.2);
      }
    }
    oldToNew.set(i, trees.length);
    trees.push(copy);
  });
  // Irregular offsets and overlapping lobes replace equally spaced Christmas-tree tiers.
  const foliageGroups = new Map<number, number[]>();
  const evergreens = trees
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.evergreen && !isCoverPrimitive(t));
  for (const { t, i } of evergreens) {
    foliageGroups.set(i, []);
    const count = 3 + Math.floor(rng.next() * 4);
    for (let k = 0; k < count; k++) {
      const phase = rng.range(0, Math.PI * 2),
        level = k / (count - 1),
        radius = 1.6 - level * 0.7;
      foliageGroups.get(i)!.push(trees.length);
      trees.push({
        ...t,
        x: t.x + Math.cos(phase) * (0.25 + 0.45 * (1 - level)),
        z: t.z + Math.sin(phase) * (0.25 + 0.45 * (1 - level)),
        trunkR: 0,
        trunkTop: 0,
        canopyY: t.groundY + 4.4 + level * 3.7 + rng.range(-0.35, 0.35),
        canopyR: radius,
        foliageOnly: true,
      });
    }
  }
  const covers: CoverObject[] = [];
  for (const c of base.covers) {
    if (c.kind === "log" || replaced.has(c.id)) continue;
    const primitives = c.primitives
      .map((i) => oldToNew.get(i))
      .filter((i): i is number => i !== undefined);
    if (!primitives.length) continue;
    covers.push({ ...c, primitives });
    groups.push({
      id: `legacy-${c.id}`,
      kind: c.kind,
      x: c.x,
      z: c.z,
      radius: c.radius,
      length: c.length,
      yaw: c.yaw,
      treeIndices: primitives,
      solidIds: [],
    });
  }
  const world: ThreeWorld & RichWorld = {
    seed: base.seed,
    half: base.half,
    rocks: base.rocks,
    heightAt: base.heightAt,
    terrainFamily: "rich-v1",
    ponds: base.ponds,
    trees,
    covers,
    n3WorldVersion: THREE_WORLD_VERSION,
    n3Solids: solids,
    n3Covers: groups,
  };
  let rockIndex = 0;
  for (const c of eligible) {
    const radius = Math.max(
        FOREST.boulderRadiusMin,
        Math.min(FOREST.boulderRadiusMax, c.radius * rng.range(1.05, 1.35)),
      ),
      height = rng.range(FOREST.boulderHeightMin, FOREST.boulderHeightMax),
      id = `rock-${rockIndex++}`;
    const solid = makeBoulder(
      id,
      c.x,
      c.z,
      base.heightAt(c.x, c.z),
      radius,
      height,
      rng,
    );
    solids.push(solid);
    groups.push({
      id,
      kind: "boulder",
      x: c.x,
      z: c.z,
      radius,
      length: 0,
      yaw: 0,
      treeIndices: [],
      solidIds: [id],
    });
  }
  for (const c of base.covers.filter((c) => c.kind === "log")) {
    const id = `log-${c.id}`,
      solid = makeLog(
        id,
        c.x,
        c.z,
        base.heightAt(c.x, c.z),
        c.radius,
        c.length,
        c.yaw,
      );
    solids.push(solid);
    groups.push({
      id,
      kind: "log",
      x: c.x,
      z: c.z,
      radius: c.radius,
      length: c.length,
      yaw: c.yaw,
      treeIndices: [],
      solidIds: [id],
    });
  }
  groups.push(
    ...treeGroups(world).map((g) => ({
      ...g,
      treeIndices: [
        ...g.treeIndices,
        ...(foliageGroups.get(g.treeIndices[0]) ?? []),
      ],
    })),
  );
  return world;
}
