import type { Frame } from "./types";

export interface Sample {
  a: Frame;
  b: Frame;
  /** 0..1 blend between frame a and b (render-time interpolation of the fixed-step replay). */
  u: number;
  t: number;
}

export function sampleAt(frames: Frame[], t: number): Sample {
  const dt = frames[1].t - frames[0].t;
  const end = frames[frames.length - 1].t;
  const tt = Math.min(Math.max(t, 0), end);
  const f = tt / dt;
  const i = Math.min(frames.length - 2, Math.floor(f));
  return { a: frames[i], b: frames[i + 1], u: f - i, t: tt };
}

export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

export function lerpAngle(a: number, b: number, u: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
}
