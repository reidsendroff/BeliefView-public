/** Subject-side delayed/noisy position cues, independent from all drone sensing and planning. */
import { Rng } from "../sim/rng";
import { SUBJECT } from "../sim/subject";
import type { Vec3 } from "../sim/types";
import { THREE_IDS, type SensorId } from "./types";
export interface ThreatCue {
  id: SensorId;
  position: Vec3;
  sensedAt: number;
}
export class ThreePerception {
  private histories = new Map<SensorId, { t: number; pos: Vec3 }[]>();
  private rngs = new Map<SensorId, Rng>();
  private cues = new Map<SensorId, ThreatCue>();
  private next = 0;
  constructor(seed: number) {
    for (const [i, id] of THREE_IDS.entries()) {
      this.histories.set(id, []);
      this.rngs.set(id, new Rng((seed ^ Math.imul(i + 1, 0x29a7b3d)) >>> 0));
    }
  }
  observe(
    positions: readonly { id: SensorId; position: Vec3 }[],
    own: { x: number; z: number },
    now: number,
  ): ThreatCue[] {
    const seen = new Set<SensorId>();
    for (const row of positions) {
      if (!THREE_IDS.includes(row.id) || seen.has(row.id))
        throw Error("Invalid subject perception cohort");
      seen.add(row.id);
      const p = row.position;
      if (![p.x, p.y, p.z].every(Number.isFinite))
        throw Error("Invalid perceived physical input");
      const h = this.histories.get(row.id)!;
      h.push({ t: now, pos: { x: p.x, y: p.y, z: p.z } });
      while (h.length && h[0].t < now - 3) h.shift();
    }
    if (now + 1e-9 >= this.next) {
      this.next = now + SUBJECT.perceptionRefresh;
      for (const id of THREE_IDS) {
        const rng = this.rngs.get(id)!,
          nx = rng.normal(),
          nz = rng.normal(),
          ny = rng.normal(),
          h = this.histories.get(id)!,
          old = [...h]
            .reverse()
            .find((p) => p.t <= now - SUBJECT.perceptionDelay + 1e-9);
        if (
          !old ||
          old.t <
            now - SUBJECT.perceptionDelay - SUBJECT.perceptionRefresh - 0.01 ||
          Math.hypot(old.pos.x - own.x, old.pos.z - own.z) >
            SUBJECT.perceptionRange
        )
          continue;
        const n = {
            x: old.pos.x + nx * SUBJECT.perceptionNoise,
            y: old.pos.y + ny * SUBJECT.perceptionNoise,
            z: old.pos.z + nz * SUBJECT.perceptionNoise,
          },
          prior = this.cues.get(id),
          a = SUBJECT.perceptionSmoothing;
        this.cues.set(id, {
          id,
          sensedAt: old.t,
          position: prior
            ? {
                x: prior.position.x + a * (n.x - prior.position.x),
                y: prior.position.y + a * (n.y - prior.position.y),
                z: prior.position.z + a * (n.z - prior.position.z),
              }
            : n,
        });
      }
    }
    for (const [id, c] of this.cues)
      if (now - c.sensedAt > 2) this.cues.delete(id);
    return THREE_IDS.flatMap((id) => {
      const c = this.cues.get(id);
      return c
        ? [
            {
              id,
              sensedAt: c.sensedAt,
              position: { x: c.position.x, y: c.position.y, z: c.position.z },
            },
          ]
        : [];
    });
  }
}
