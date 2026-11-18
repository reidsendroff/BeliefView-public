/** Analytic approximate team belief. Grid-cell likelihoods integrate measurement extent; no ONNX/model claim. */
import { Tracker } from "../sim/tracker";
import type { TrackerSnapshot } from "../sim/types";
import { EvidenceLedger } from "./evidence";
import { TeamMap, fraction } from "./map";
import { GRID, type Evidence, type PublicRegion, type SensorId } from "./types";
function cdf(x: number): number {
  const sign = x < 0 ? -1 : 1,
    z = Math.abs(x) / Math.SQRT2,
    t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}
export class TeamBelief {
  readonly ledger: EvidenceLedger;
  readonly tracker = new Tracker();
  probability: Float64Array;
  time = 0;
  private lastEmpty: Float64Array;
  private epochTime = -Infinity;
  private epochMask: Uint16Array;
  private epochExposure: Float64Array;
  readonly stats = { emptyCellUpdates: 0, positiveUpdates: 0 };
  constructor(
    readonly map: TeamMap,
    region: PublicRegion,
    ids: readonly SensorId[] = ["A", "B"],
  ) {
    this.ledger = new EvidenceLedger(ids);
    this.probability = map.prior(region);
    this.lastEmpty = new Float64Array(map.cells.length).fill(-1e9);
    this.epochMask = new Uint16Array(map.cells.length);
    this.epochExposure = new Float64Array(map.cells.length);
  }
  advance(to: number) {
    const dt = to - this.time;
    if (dt <= 1e-9) return;
    const before = this.tracker.snapshot(),
      speed = Math.hypot(before.vx, before.vz),
      scale = speed > 7 ? 7 / speed : 1;
    const dx = before.initialised ? before.vx * scale * dt : 0,
      dz = before.initialised ? before.vz * scale * dt : 0;
    const spread = before.initialised ? 2 + Math.min(before.age, 12) * 1.3 : 18,
      r = Math.min(0.22, (spread * dt) / (GRID.cell * GRID.cell));
    const next = new Float64Array(this.probability.length);
    for (let k = 0; k < next.length; k++) {
      const mass = this.probability[k];
      if (!mass) continue;
      const gx = (k % GRID.n) + dx / GRID.cell,
        gz = Math.floor(k / GRID.n) + dz / GRID.cell,
        x0 = Math.floor(gx),
        z0 = Math.floor(gz),
        fx = gx - x0,
        fz = gz - z0;
      for (const [ox, oz, w] of [
        [0, 0, (1 - fx) * (1 - fz)],
        [1, 0, fx * (1 - fz)],
        [0, 1, (1 - fx) * fz],
        [1, 1, fx * fz],
      ]) {
        const col = Math.max(0, Math.min(GRID.n - 1, x0 + ox)),
          row = Math.max(0, Math.min(GRID.n - 1, z0 + oz));
        const at = row * GRID.n + col;
        const anchor = this.map.cells[at].valid ? at : k;
        next[anchor] += mass * w * (1 - 4 * r);
        for (const [cx, cz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const x = Math.max(0, Math.min(GRID.n - 1, (anchor % GRID.n) + cx)),
            z = Math.max(
              0,
              Math.min(GRID.n - 1, Math.floor(anchor / GRID.n) + cz),
            ),
            j = z * GRID.n + x;
          next[this.map.cells[j].valid ? j : anchor] += mass * w * r;
        }
      }
    }
    // Small public escape component prevents a moving target becoming permanently unsupported.
    const area = this.map.cells.reduce((s, c) => s + (c.valid ? c.area : 0), 0),
      escape = Math.min(0.1, 0.002 * dt);
    for (let k = 0; k < next.length; k++)
      next[k] =
        next[k] * (1 - escape) +
        (this.map.cells[k].valid
          ? (this.map.cells[k].area / area) * escape
          : 0);
    this.map.normalize(next);
    this.probability = next;
    this.tracker.predict(dt);
    this.time = to;
  }
  ingest(batch: readonly Evidence[], now: number) {
    const accepted = this.ledger.accept(batch, now, this.time);
    for (let i = 0; i < accepted.length;) {
      const at = accepted[i].sensedAt,
        group: Evidence[] = [];
      while (i < accepted.length && accepted[i].sensedAt === at)
        group.push(accepted[i++]);
      this.advance(at);
      const empty = new Uint16Array(this.probability.length);
      for (const e of group) {
        if (e.observation) {
          const o = e.observation;
          this.tracker.update(o);
          this.stats.positiveUpdates++;
          for (let k = 0; k < this.probability.length; k++) {
            const c = this.map.cells[k];
            const wx =
                cdf((c.maxX - o.x) / o.sigma) - cdf((c.minX - o.x) / o.sigma),
              wz =
                cdf((c.maxZ - o.z) / o.sigma) - cdf((c.minZ - o.z) / o.sigma);
            this.probability[k] *= Math.max(
              1e-12,
              (wx * wz) / Math.max(c.area, 1e-9),
            );
          }
          this.map.normalize(this.probability);
        } else {
          const mask = this.map.footprint(e.pose);
          for (let k = 0; k < empty.length; k++) empty[k] |= mask[k];
        }
      }
      // A timestamp is an evidence epoch. Incremental union ratios make split A/B
      // deliveries at the same sensing/processing time equivalent to one atomic batch.
      if (at !== this.epochTime) {
        this.epochTime = at;
        this.epochMask.fill(0);
        for (let k = 0; k < this.epochExposure.length; k++)
          this.epochExposure[k] = Math.min(
            1,
            Math.max(0, (at - this.lastEmpty[k]) / 1.5),
          );
      }
      for (let k = 0; k < empty.length; k++)
        if (empty[k]) {
          const old = this.epochMask[k],
            combined = old | empty[k],
            exposure = this.epochExposure[k];
          const prior = Math.pow(1 - 0.8 * fraction(old), exposure),
            next = Math.pow(1 - 0.8 * fraction(combined), exposure);
          this.probability[k] *= next / prior;
          this.epochMask[k] = combined;
          this.lastEmpty[k] = at;
          if (!old) this.stats.emptyCellUpdates++;
        }
      this.map.normalize(this.probability);
    }
    this.advance(now);
    return accepted;
  }
  summary() {
    let x = 0,
      z = 0,
      entropy = 0;
    for (let k = 0; k < this.probability.length; k++) {
      const p = this.probability[k];
      x += p * this.map.cells[k].x;
      z += p * this.map.cells[k].z;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    let variance = 0;
    for (let k = 0; k < this.probability.length; k++)
      variance +=
        this.probability[k] *
        ((this.map.cells[k].x - x) ** 2 + (this.map.cells[k].z - z) ** 2);
    return { x, z, radius: Math.sqrt(variance) * 1.73, entropy };
  }
  controlSnapshot(): TrackerSnapshot {
    const t = this.tracker.snapshot(),
      b = this.summary();
    return t.initialised && t.age <= 1.5
      ? t
      : {
          ...t,
          x: b.x,
          z: b.z,
          sigma: b.radius / 2.447,
          radius: b.radius,
          status: "SEARCHING",
        };
  }
}
