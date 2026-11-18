/** Cached static LOS for quantized public support viewpoints; FOV is recomputed for actual planned gaze. */
import { DRONE } from "../sim/drone";
import { lineOfSight } from "../sim/geometry";
import { fovTest } from "../sim/sensor";
import { inWater } from "../sim/richWorld";
import { TeamMap, fraction, type View } from "./map";
import { THREE } from "./threeConstants";
export class ThreeViews {
  private cache = new Map<string, Uint16Array>();
  constructor(private map: TeamMap) {}
  view(x: number, z: number, gaze: { x: number; z: number }): View {
    const w = this.map.world,
      y = w.heightAt(x, z) + DRONE.searchAgl,
      key = x + "," + z;
    let visible = this.cache.get(key);
    if (!visible) {
      visible = new Uint16Array(this.map.cells.length);
      const local = {
        seed: w.seed,
        half: w.half,
        heightAt: w.heightAt,
        rocks: [],
        trees: w.trees.filter(
          (t) => Math.abs(t.x - x) < 45 && Math.abs(t.z - z) < 45,
        ),
      };
      for (let k = 0; k < this.map.cells.length; k++) {
        const c = this.map.cells[k];
        if (!c.valid || Math.hypot(c.x - x, c.z - z) > 43) continue;
        for (let j = 0; j < c.samples.length; j++) {
          const q = c.samples[j];
          if (
            !inWater(w, q.x, q.z) &&
            (this.map.geometry
              ? this.map.geometry.lineOfSight({ x, y, z }, q)
              : lineOfSight(local, { x, y, z }, q)) === "NONE"
          )
            visible[k] |= 1 << j;
        }
      }
      if (this.cache.size >= THREE.visibilityCacheLimit)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, visible);
    }
    const yaw = Math.atan2(gaze.x - x, gaze.z - z),
      pitch = Math.max(
        -1.5,
        Math.min(
          0.2,
          Math.atan2(
            w.heightAt(gaze.x, gaze.z) + DRONE.targetHeight - y,
            Math.hypot(gaze.x - x, gaze.z - z),
          ),
        ),
      );
    const pose = { x, y, z, yaw, pitch },
      indices: number[] = [],
      bits: number[] = [],
      fractions: number[] = [];
    for (let k = 0; k < visible.length; k++)
      if (visible[k]) {
        let mask = 0;
        for (let j = 0; j < 10; j++)
          if (visible[k] & (1 << j)) {
            const f = fovTest(pose, yaw, pitch, this.map.cells[k].samples[j]);
            if (f.inFov && f.inRange) mask |= 1 << j;
          }
        if (mask) {
          indices.push(k);
          bits.push(mask);
          fractions.push(fraction(mask));
        }
      }
    return {
      x,
      y,
      z,
      yaw,
      pitch,
      gaze: { x: gaze.x, z: gaze.z },
      indices: Uint16Array.from(indices),
      bits: Uint16Array.from(bits),
      fractions: Float32Array.from(fractions),
    };
  }
  get cachedPositions() {
    return this.cache.size;
  }
}
