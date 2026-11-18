/** Identical conservative swept-separation hold for every arm. Counts holds/deadlocks as outcomes. */
import type { DroneState } from "../sim/drone";
import { TEAM, type SensorId } from "./types";
export function sweptSeparation(
  a0: Pick<DroneState, "pos">,
  a1: Pick<DroneState, "pos">,
  b0: Pick<DroneState, "pos">,
  b1: Pick<DroneState, "pos">,
): number {
  const r = {
      x: a0.pos.x - b0.pos.x,
      y: a0.pos.y - b0.pos.y,
      z: a0.pos.z - b0.pos.z,
    },
    v = {
      x: a1.pos.x - b1.pos.x - r.x,
      y: a1.pos.y - b1.pos.y - r.y,
      z: a1.pos.z - b1.pos.z - r.z,
    };
  const vv = v.x * v.x + v.y * v.y + v.z * v.z,
    u = vv
      ? Math.max(0, Math.min(1, -(r.x * v.x + r.y * v.y + r.z * v.z) / vv))
      : 0;
  return Math.hypot(r.x + u * v.x, r.y + u * v.y, r.z + u * v.z);
}
export function enforceSeparation(
  before: readonly { id: SensorId; state: DroneState }[],
  after: { id: SensorId; state: DroneState }[],
): boolean {
  if (before.length !== 2 || after.length !== 2)
    throw new Error("Two physical aircraft required");
  const old = [...before].sort((a, b) => a.id.localeCompare(b.id)),
    next = [...after].sort((a, b) => a.id.localeCompare(b.id));
  if (
    sweptSeparation(old[0].state, next[0].state, old[1].state, next[1].state) >=
    TEAM.separation
  )
    return false;
  for (let k = 0; k < 2; k++) {
    next[k].state.pos = { ...old[k].state.pos };
    next[k].state.vel = { x: 0, y: 0, z: 0 };
  }
  return true;
}
