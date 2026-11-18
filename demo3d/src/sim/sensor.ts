import type { Vec3 } from "./types";

/** Drone camera model. Shared by the simulation (detection) and the renderer (frustum + inset). */
export const CAMERA = {
  hHalf: (36 * Math.PI) / 180,
  aspect: 16 / 9,
  maxRange: 38,
  get vHalf(): number {
    return Math.atan(Math.tan(this.hHalf) / this.aspect);
  },
};

/** Forward vector for a gimbal with yaw (about +y, 0 = +z) and pitch (negative = looking down). */
export function forward(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
}

export function cameraBasis(yaw: number, pitch: number): { f: Vec3; r: Vec3; u: Vec3 } {
  const f = forward(yaw, pitch);
  // right = f x up(0,1,0) normalised; for yaw=0 (f=+z) right = +x ... use left-handed-consistent construction
  const r = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  // u should point up: flip if needed
  if (u.y < 0) return { f, r, u: { x: -u.x, y: -u.y, z: -u.z } };
  return { f, r, u };
}

export interface FovResult {
  range: number;
  inRange: boolean;
  inFov: boolean;
}

export function fovTest(camPos: Vec3, yaw: number, pitch: number, p: Vec3): FovResult {
  const { f, r, u } = cameraBasis(yaw, pitch);
  const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
  const zc = dx * f.x + dy * f.y + dz * f.z;
  const xc = dx * r.x + dy * r.y + dz * r.z;
  const yc = dx * u.x + dy * u.y + dz * u.z;
  const range = Math.hypot(dx, dy, dz);
  const inFov = zc > 0.5 && Math.abs(xc / zc) <= Math.tan(CAMERA.hHalf) && Math.abs(yc / zc) <= Math.tan(CAMERA.vHalf);
  return { range, inRange: range <= CAMERA.maxRange, inFov };
}
