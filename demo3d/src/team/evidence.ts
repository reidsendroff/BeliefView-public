/** Deterministic, source-tagged ingestion. Missing packets are not empty observations. */
import type { Evidence, SensorId } from "./types";
function copyValid(raw: Evidence, allowed: ReadonlySet<SensorId>): Evidence | null {
  try {
    const { messageId, sensorId, sensedAt, receivedAt } = raw;
    if (
      typeof messageId !== "string" ||
      !messageId.length ||
      messageId.length > 128 ||
      !allowed.has(sensorId) ||
      ![sensedAt, receivedAt].every(Number.isFinite) ||
      sensedAt < 0 ||
      receivedAt < sensedAt
    )
      return null;
    const p = raw.pose,
      pose = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch };
    if (!Object.values(pose).every(Number.isFinite)) return null;
    const o = raw.observation;
    if (
      o !== null &&
      (!o ||
        ![o.t, o.x, o.z, o.sigma].every(Number.isFinite) ||
        o.sigma <= 0 ||
        Math.abs(o.t - sensedAt) > 1e-8)
    )
      return null;
    const observation =
      o === null
        ? null
        : Object.freeze({ t: sensedAt, x: o.x, z: o.z, sigma: o.sigma });
    return Object.freeze({
      messageId,
      sensorId,
      sensedAt,
      receivedAt,
      pose: Object.freeze(pose),
      observation,
    });
  } catch {
    return null;
  }
}
function payload(e: Evidence) {
  return JSON.stringify([
    e.sensedAt,
    e.pose.x,
    e.pose.y,
    e.pose.z,
    e.pose.yaw,
    e.pose.pitch,
    e.observation,
  ]);
}
export class EvidenceLedger {
  private readonly allowed: ReadonlySet<SensorId>;
  constructor(ids: readonly SensorId[] = ["A", "B"]) {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !["A", "B", "C"].includes(id))) throw new Error("Invalid sensor cohort");
    this.allowed = new Set(ids);
  }
  private seen = new Map<string, string>();
  private appliedAt = -Infinity;
  private lastNow = -Infinity;
  stats = {
    accepted: 0,
    duplicates: 0,
    conflicts: 0,
    stale: 0,
    future: 0,
    invalid: 0,
  };
  accept(
    batch: readonly Evidence[],
    now: number,
    minimumTime = -Infinity,
  ): Evidence[] {
    if (
      !Number.isFinite(now) ||
      now < this.lastNow ||
      Number.isNaN(minimumTime)
    )
      throw new Error("Evidence clock must be finite and monotonic");
    this.lastNow = now;
    const valid: Evidence[] = [],
      fingerprints = new Map<string, string>(),
      conflicts = new Set<string>();
    for (const raw of batch) {
      const e = copyValid(raw, this.allowed);
      if (!e) {
        this.stats.invalid++;
        continue;
      }
      const key = e.sensorId + ":" + e.messageId,
        print = payload(e),
        previous = fingerprints.get(key) ?? this.seen.get(key);
      if (previous !== undefined && previous !== print) conflicts.add(key);
      fingerprints.set(key, print);
      valid.push(e);
    }
    const accepted: Evidence[] = [];
    for (const e of valid.sort(
      (a, b) =>
        a.sensedAt - b.sensedAt ||
        a.sensorId.localeCompare(b.sensorId) ||
        a.messageId.localeCompare(b.messageId),
    )) {
      const key = e.sensorId + ":" + e.messageId;
      if (conflicts.has(key)) {
        this.stats.conflicts++;
        continue;
      }
      if (this.seen.has(key)) {
        this.stats.duplicates++;
        continue;
      }
      if (e.receivedAt > now + 1e-8 || e.sensedAt > now + 1e-8) {
        this.stats.future++;
        continue;
      }
      if (e.sensedAt < Math.max(this.appliedAt, minimumTime) - 1e-8) {
        this.stats.stale++;
        continue;
      }
      accepted.push(e);
      this.seen.set(key, payload(e));
      this.appliedAt = Math.max(this.appliedAt, e.sensedAt);
      this.stats.accepted++;
    }
    return accepted;
  }
}
