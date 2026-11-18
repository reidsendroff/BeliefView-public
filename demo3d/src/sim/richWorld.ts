/** Synthetic rich terrain. Explicit primitive adapters keep legacy forest physics/provenance unchanged. */
import { buildWorld, type SimConfig } from "./simulate";
import { distToPolyline } from "./route";
import { Rng } from "./rng";
import type { Tree, World } from "./world";
export type CoverKind = "boulder" | "log" | "bush" | "leaf-pile";
export interface CoverObject {
  id: number;
  kind: CoverKind;
  x: number;
  z: number;
  y: number;
  radius: number;
  length: number;
  yaw: number;
  primitives: number[];
}
export interface CoverPrimitive extends Tree {
  coverKind: CoverKind;
  coverId: number;
}
export interface RichTree extends Tree {
  evergreen?: boolean;
  foliageOnly?: boolean;
}
export interface Pond {
  x: number;
  z: number;
  radius: number;
  level: number;
}
export interface RichWorld extends World {
  terrainFamily: "rich-v1";
  covers: CoverObject[];
  ponds: Pond[];
}
export const isRichWorld = (w: World): w is RichWorld =>
  (w as Partial<RichWorld>).terrainFamily === "rich-v1";
export const inWater = (w: World, x: number, z: number, margin = 0): boolean =>
  isRichWorld(w) &&
  w.ponds.some((p) => Math.hypot(x - p.x, z - p.z) < p.radius + margin);
export const isCoverPrimitive = (t: Tree): t is CoverPrimitive =>
  "coverKind" in t;

export function buildRichWorld(config: SimConfig): RichWorld {
  const base = buildWorld(config),
    rng = new Rng(config.seed ^ 0x51a7c0de);
  const pond: Pond = {
    x: -5 + rng.range(-4, 4),
    z: 15 + rng.range(-3, 3),
    radius: 6.5 + rng.range(0, 1.5),
    level: 0,
  };
  const relief = Array.from({ length: 7 }, (_, i) => ({
    x: rng.range(-60, 60),
    z: rng.range(-60, 60),
    amplitude: i % 3 === 0 ? -2 : rng.range(2, 4),
    sx: rng.range(10, 18),
    sz: rng.range(6, 13),
  }));
  const rollingHeight = (x: number, z: number) =>
    base.heightAt(x, z) +
    relief.reduce(
      (h, m) =>
        h +
        m.amplitude *
          Math.exp(-(((x - m.x) / m.sx) ** 2) - ((z - m.z) / m.sz) ** 2),
      0,
    );
  pond.level = rollingHeight(pond.x, pond.z);
  const heightAt = (x: number, z: number) => {
    const h = rollingHeight(x, z),
      d = Math.hypot(x - pond.x, z - pond.z),
      a = Math.max(0, Math.min(1, (pond.radius + 2 - d) / 2));
    const smooth = a * a * (3 - 2 * a);
    return h + (pond.level - h) * smooth;
  };
  const trees: RichTree[] = base.trees
    .filter((t) => Math.hypot(t.x - pond.x, t.z - pond.z) > pond.radius + 2)
    .map((t) => {
      const y = heightAt(t.x, t.z);
      return {
        ...t,
        trunkR: rng.next() < 0.26 ? rng.range(0.6, 0.95) : rng.range(0.16, 0.4),
        groundY: y,
        canopyY: t.canopyY + y - t.groundY,
      };
    });
  // Irregular satellites around existing stands. Public route corridors remain open.
  const anchors = trees.filter((_, i) => i % 17 === 0);
  for (const anchor of anchors)
    for (let j = 0; j < 3; j++) {
      const a = rng.range(0, Math.PI * 2),
        d = rng.range(1.5, 3.2),
        x = anchor.x + Math.cos(a) * d,
        z = anchor.z + Math.sin(a) * d;
      if (
        distToPolyline(config.waypoints, x, z) < 3.2 ||
        Math.hypot(x - pond.x, z - pond.z) < pond.radius + 2 ||
        trees.some((t) => Math.hypot(t.x - x, t.z - z) < t.trunkR + 0.7)
      )
        continue;
      const y = heightAt(x, z);
      trees.push({
        ...anchor,
        x,
        z,
        groundY: y,
        trunkR: rng.range(0.15, 0.35),
        canopyY: y + 8 + rng.range(0, 3),
        canopyR: rng.range(2.2, 3.4),
      });
    }
  // Explicit opaque spherical skirts taper upward, sharing geometry with sensor and renderer.
  const foliage: RichTree[] = [];
  trees.forEach((t, i) => {
    if (i % 9 !== 2) return;
    t.evergreen = true;
    t.trunkTop = 9;
    t.canopyR = 2.25;
    t.canopyY = t.groundY + 2.5;
    for (let k = 1; k <= 4; k++)
      foliage.push({
        ...t,
        trunkR: 0,
        trunkTop: 0,
        canopyR: 2.25 - k * 0.4,
        canopyY: t.groundY + 2.5 + k * 1.55,
        foliageOnly: true,
      });
  });
  trees.push(...foliage);
  const w: RichWorld = {
    ...base,
    heightAt,
    trees,
    rocks: [],
    terrainFamily: "rich-v1",
    covers: [],
    ponds: [pond],
  };
  const add = (
    kind: CoverKind,
    x: number,
    z: number,
    r: number,
    length = 0,
    yaw = 0,
  ) => {
    if (
      inWater(w, x, z, r + length / 2 + 2) ||
      Math.hypot(x - config.waypoints[0][0], z - config.waypoints[0][1]) < 6
    )
      return;
    const y = heightAt(x, z),
      id = w.covers.length;
    const ob: CoverObject = {
      id,
      kind,
      x,
      z,
      y,
      radius: r,
      length,
      yaw,
      primitives: [],
    };
    const steps = kind === "log" ? Math.ceil(length / 0.4) : 0;
    for (let k = 0; k <= steps; k++) {
      const offset = steps ? (k / steps - 0.5) * length : 0,
        px = x + Math.sin(yaw) * offset,
        pz = z + Math.cos(yaw) * offset;
      // Spheres form conservative boulders, vegetation mounds and a closely sampled capsule for logs.
      const centerY =
        kind === "leaf-pile" ? y : kind === "bush" ? y + r * 0.2 : y + r * 0.65;
      const groundY = heightAt(px, pz);
      const primitive: CoverPrimitive = {
        x: px,
        z: pz,
        groundY,
        trunkR: r,
        trunkTop: 0,
        canopyR: r,
        canopyY: centerY,
        hue: 0,
        grove: false,
        coverKind: kind,
        coverId: id,
      };
      ob.primitives.push(trees.length);
      trees.push(primitive);
    }
    w.covers.push(ob);
  };
  // Existing decorative rocks become physical low boulders in the rich family only.
  for (const rock of base.rocks) add("boulder", rock.x, rock.z, rock.s * 0.9);
  const kinds: CoverKind[] = ["boulder", "log", "bush", "leaf-pile"];
  for (let k = 0; k < 44; k++) {
    const wp = config.waypoints[2 + (k % (config.waypoints.length - 2))],
      kind = kinds[k % 4];
    const x = wp[0] + rng.range(-12, 12),
      z = wp[1] + rng.range(-10, 10);
    const radius =
      kind === "boulder"
        ? rng.range(1.3, 2)
        : kind === "log"
          ? rng.range(0.52, 0.68)
          : kind === "bush"
            ? rng.range(0.95, 1.25)
            : rng.range(1.05, 1.18);
    add(
      kind,
      x,
      z,
      radius,
      kind === "log" ? rng.range(3, 5) : 0,
      rng.range(0, Math.PI * 2),
    );
  }
  return w;
}

/** Navigation-only shoreline barrier. NEVER supplied to sensor, feature extractor or drone. */
export function subjectNavigationWorld(w: World): World {
  if (!isRichWorld(w)) return w;
  const walls: Tree[] = [];
  for (const p of w.ponds) {
    const n = Math.ceil((2 * Math.PI * p.radius) / 0.65);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2,
        x = p.x + Math.sin(a) * p.radius,
        z = p.z + Math.cos(a) * p.radius,
        y = w.heightAt(x, z);
      walls.push({
        x,
        z,
        groundY: y,
        trunkR: 0.55,
        trunkTop: 0,
        canopyR: 0,
        canopyY: y,
        hue: 0,
        grove: false,
      });
    }
  }
  return { ...w, trees: [...w.trees, ...walls] };
}

/** Subject goals inside water are moved onto dry shoreline, without exposing destinations to guidance. */
export function drySubjectGoals(
  w: World,
  goals: [number, number][],
): [number, number][] {
  if (!isRichWorld(w)) return goals;
  return goals.map(([x, z]) => {
    for (const p of w.ponds) {
      const dx = x - p.x,
        dz = z - p.z,
        d = Math.hypot(dx, dz);
      if (d < p.radius + 3) {
        const scale = (p.radius + 3) / (d || 1);
        x = p.x + (d ? dx : 1) * scale;
        z = p.z + (d ? dz : 0) * scale;
      }
    }
    return [x, z];
  });
}
