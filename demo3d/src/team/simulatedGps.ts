/** Display-only local map conversion. Never imported by sensing, inference or flight policy. */
export const SIMULATED_GPS = {
  latitude: 45,
  longitude: -93,
  radiusM: 6378137,
} as const;
/** x is east; z is north. This small-area spherical approximation is not surveyed georeferencing. */
export function simulatedGps(point: {
  x: number;
  z: number;
}): { latitude: number; longitude: number } | null {
  try {
    const x = point.x,
      z = point.z;
    if (
      typeof x !== "number" ||
      typeof z !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(z)
    )
      return null;
    const latitude =
      SIMULATED_GPS.latitude + ((z / SIMULATED_GPS.radiusM) * 180) / Math.PI;
    const longitude =
      SIMULATED_GPS.longitude +
      ((x /
        (SIMULATED_GPS.radiusM *
          Math.cos((SIMULATED_GPS.latitude * Math.PI) / 180))) *
        180) /
        Math.PI;
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? { latitude, longitude }
      : null;
  } catch {
    return null;
  }
}
const decimal = (v: number) => (Math.abs(v) < 0.0000005 ? 0 : v).toFixed(6);
export function simulatedGpsText(point: { x: number; z: number }): string {
  const gps = simulatedGps(point);
  return gps
    ? `${decimal(gps.latitude)}, ${decimal(gps.longitude)}`
    : "unavailable";
}
