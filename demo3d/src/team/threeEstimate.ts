/** Public accepted-report fusion for view tasking, not a calibrated posterior. */
import type { Evidence, SensorId } from "./types";
import { THREE_IDS } from "./types";
import { THREE } from "./threeConstants";
export interface ReportSource {
  id: SensorId;
  sensedAt: number;
  x: number;
  z: number;
  sigma: number;
  age: number;
  predictedX: number;
  predictedZ: number;
}
export interface ViewEstimate {
  x: number;
  z: number;
  radius: number;
  t: number;
  sources: ReportSource[];
  excluded: { id: SensorId; reason: "stale" | "inconsistent" }[];
}
type Stored = {
  id: SensorId;
  sensedAt: number;
  x: number;
  z: number;
  sigma: number;
};
export class ThreeEstimate {
  private latest = new Map<SensorId, Stored>();
  private included = new Set<string>();
  update(
    accepted: readonly Evidence[],
    now: number,
    velocity: { vx: number; vz: number },
  ): ViewEstimate | null {
    if (
      !Number.isFinite(now) ||
      ![velocity.vx, velocity.vz].every(Number.isFinite)
    )
      throw Error("Invalid public estimate clock/velocity");
    for (const e of accepted) {
      const o = e.observation;
      if (
        !o ||
        !THREE_IDS.includes(e.sensorId) ||
        ![e.sensedAt, o.x, o.z, o.sigma].every(Number.isFinite) ||
        o.sigma <= 0 ||
        e.sensedAt > now + 1e-8
      )
        continue;
      const old = this.latest.get(e.sensorId);
      if (!old || e.sensedAt >= old.sensedAt)
        this.latest.set(e.sensorId, {
          id: e.sensorId,
          sensedAt: e.sensedAt,
          x: o.x,
          z: o.z,
          sigma: o.sigma,
        });
    }
    const speed = Math.hypot(velocity.vx, velocity.vz),
      scale = Math.min(1, THREE.velocityCapMps / Math.max(speed, 1e-9));
    const all = [...this.latest.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const fresh = all.filter(
      (r) => now - r.sensedAt <= THREE.freshnessS + 1e-8,
    );
    if (!fresh.length) {
      this.included.clear();
      return null;
    }
    const pair = (a: Stored, b: Stored) => {
      const key = [a.id, b.id].sort().join("");
      const gate = Math.max(
        THREE.consistencyMinimumM,
        THREE.consistencySigma * (a.sigma + b.sigma) +
          THREE.uncertaintyGrowthMps * Math.abs(a.sensedAt - b.sensedAt),
      );
      return (
        Math.hypot(a.x - b.x, a.z - b.z) <=
        gate * (this.included.has(key) ? THREE.consistencyHysteresis : 1)
      );
    };
    let chosen: Stored[] = [],
      bestVariance = Infinity,
      bestKey = "";
    for (let mask = 1; mask < 1 << fresh.length; mask++) {
      const subset = fresh.filter((_, i) => mask & (1 << i));
      if (subset.some((a, i) => subset.slice(i + 1).some((b) => !pair(a, b))))
        continue;
      const variance = subset.reduce(
          (s, r) =>
            s +
            (r.sigma + THREE.uncertaintyGrowthMps * (now - r.sensedAt)) ** 2,
          0,
        ),
        key = subset.map((r) => r.id).join("");
      if (
        subset.length > chosen.length ||
        (subset.length === chosen.length &&
          (variance < bestVariance - 1e-12 ||
            (Math.abs(variance - bestVariance) < 1e-12 && key < bestKey)))
      ) {
        chosen = subset;
        bestVariance = variance;
        bestKey = key;
      }
    }
    this.included.clear();
    for (let i = 0; i < chosen.length; i++)
      for (let j = i + 1; j < chosen.length; j++)
        this.included.add(chosen[i].id + chosen[j].id);
    const sources = chosen.map((r) => {
      const age = Math.max(0, now - r.sensedAt),
        dt = Math.min(age, THREE.predictionS);
      return {
        ...r,
        age,
        predictedX: r.x + velocity.vx * scale * dt,
        predictedZ: r.z + velocity.vz * scale * dt,
      };
    });
    let weight = 0,
      x = 0,
      z = 0;
    for (const r of sources) {
      const w = 1 / (r.sigma + THREE.uncertaintyGrowthMps * r.age) ** 2;
      weight += w;
      x += w * r.predictedX;
      z += w * r.predictedZ;
    }
    x /= weight;
    z /= weight;
    const rms = Math.sqrt(
      sources.reduce(
        (s, r) => s + (r.predictedX - x) ** 2 + (r.predictedZ - z) ** 2,
        0,
      ) / sources.length,
    );
    return {
      x,
      z,
      t: now,
      radius:
        Math.max(
          ...sources.map((r) => r.sigma + THREE.uncertaintyGrowthMps * r.age),
        ) + rms,
      sources,
      excluded: all
        .filter((r) => !chosen.some((c) => c.id === r.id))
        .map((r) => ({
          id: r.id,
          reason:
            now - r.sensedAt > THREE.freshnessS ? "stale" : "inconsistent",
        })),
    };
  }
}
