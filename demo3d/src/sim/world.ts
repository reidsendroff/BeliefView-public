import { Rng } from "./rng";
import { distToPolyline, type XZ } from "./route";

export interface Tree {
  x: number;
  z: number;
  groundY: number;
  trunkR: number;
  /** Trunk is a vertical cylinder from groundY to groundY + trunkTop. */
  trunkTop: number;
  canopyR: number;
  /** Canopy is a sphere centred here (world coordinates). */
  canopyY: number;
  hue: number;
  grove: boolean;
}

export interface World {
  seed: number;
  half: number;
  trees: Tree[];
  rocks: { x: number; z: number; y: number; s: number }[];
  heightAt(x: number, z: number): number;
}

export const WORLD_HALF = 95;

export function terrainHeight(x: number, z: number): number {
  return (
    3.4 * Math.sin(x * 0.043 + 1.3) * Math.cos(z * 0.036) +
    1.9 * Math.sin(x * 0.09 + z * 0.07 + 2.0) +
    0.8 * Math.sin(z * 0.15 - x * 0.11) +
    0.25 * Math.sin(x * 0.4 + z * 0.33)
  );
}

/**
 * Seeded procedural forest. A dense "grove" (continuous canopy) is grown around
 * the middle section of the walker's route; elsewhere trees keep clear of the route.
 */
export function generateWorld(seed: number, path: XZ[], groveFrom: number, groveTo: number): World {
  const rng = new Rng(seed);
  const trees: Tree[] = [];
  const grovePoly = path.slice(groveFrom, groveTo);
  const make = (x: number, z: number, grove: boolean) => {
    const groundY = terrainHeight(x, z);
    const canopyR = grove ? rng.range(4.6, 6.0) : rng.range(2.6, 4.4);
    const trunkTop0 = grove ? rng.range(9.0, 11.5) : rng.range(7.5, 10.5);
    trees.push({
      x, z, groundY,
      trunkR: rng.range(0.22, 0.45),
      trunkTop: trunkTop0 + canopyR * 0.3,
      canopyR,
      canopyY: groundY + trunkTop0 + canopyR * 0.35,
      hue: rng.next(),
      grove,
    });
  };
  const cell = 5.2;
  for (let gx = -WORLD_HALF; gx < WORLD_HALF; gx += cell) {
    for (let gz = -WORLD_HALF; gz < WORLD_HALF; gz += cell) {
      const x = gx + rng.range(0.4, cell - 0.4);
      const z = gz + rng.range(0.4, cell - 0.4);
      const keep = rng.next();
      const dPath = distToPolyline(path, x, z);
      const dGrove = distToPolyline(grovePoly, x, z);
      if (dGrove >= 15 && dPath >= 9 && keep < 0.6) make(x, z, false);
    }
  }
  // Dense grove: finer jittered grid -> near-continuous canopy over the middle of the route.
  const gcell = 4.4;
  for (let gx = -WORLD_HALF; gx < WORLD_HALF; gx += gcell) {
    for (let gz = -WORLD_HALF; gz < WORLD_HALF; gz += gcell) {
      const x = gx + rng.range(0.3, gcell - 0.3);
      const z = gz + rng.range(0.3, gcell - 0.3);
      if (distToPolyline(grovePoly, x, z) < 15 && distToPolyline(path, x, z) >= 1.8) make(x, z, true);
    }
  }
  const rocks: World["rocks"] = [];
  for (let i = 0; i < 90; i++) {
    const x = rng.range(-WORLD_HALF, WORLD_HALF), z = rng.range(-WORLD_HALF, WORLD_HALF);
    const s = rng.range(0.3, 1.1);
    rocks.push({ x, z, y: terrainHeight(x, z), s });
  }
  return { seed, half: WORLD_HALF, trees, rocks, heightAt: terrainHeight };
}
