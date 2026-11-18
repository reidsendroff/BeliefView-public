export type XZ = [number, number];

/**
 * Scenario setup: the dirt trail the world is generated around, and the rough destination waypoints the
 * evasive subject is trying to get to. The subject does NOT follow this polyline any more (see subject.ts);
 * it only pulls the agent's "goal" direction. Never given to the tracker or the drone.
 */
export const DEFAULT_WAYPOINTS: XZ[] = [
  [-28, -27], [-18, -24], [-9, -17], [0, -10], [7, -3], [11, 3],
  [5, 10], [-5, 13], [-10, 22], [-4, 33], [8, 42], [24, 48], [40, 50],
];

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** Dense Catmull-Rom polyline through the waypoints (used for world generation and trail art only). */
export function samplePath(wps: XZ[], perSeg = 24): XZ[] {
  const out: XZ[] = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const p0 = wps[Math.max(0, i - 1)], p1 = wps[i], p2 = wps[i + 1], p3 = wps[Math.min(wps.length - 1, i + 2)];
    for (let k = 0; k < perSeg; k++) {
      const u = k / perSeg;
      out.push([catmull(p0[0], p1[0], p2[0], p3[0], u), catmull(p0[1], p1[1], p2[1], p3[1], u)]);
    }
  }
  out.push(wps[wps.length - 1]);
  return out;
}

export function distToPolyline(poly: XZ[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const [ax, az] = poly[i - 1], [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    const u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - (ax + dx * u), z - (az + dz * u)));
  }
  return best;
}
