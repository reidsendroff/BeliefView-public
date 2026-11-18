/** Exact weighted union of the existing ten subcell/posture sample bits. */
import { fraction, type View } from "./map";
export function denseMask(
  view: Pick<View, "indices" | "bits">,
  count: number,
): Uint16Array {
  const mask = new Uint16Array(count);
  for (let i = 0; i < view.indices.length; i++)
    mask[view.indices[i]] = view.bits[i];
  return mask;
}
const FRACTION = Float64Array.from({ length: 1024 }, (_, i) => fraction(i));
export function unionMass(
  probability: ArrayLike<number>,
  masks: readonly Uint16Array[],
): number {
  let mass = 0;
  for (let k = 0; k < probability.length; k++) {
    let bits = 0;
    for (const mask of masks) bits |= mask[k];
    mass += probability[k] * FRACTION[bits & 1023];
  }
  return mass;
}
export function angularGaps(
  points: readonly { x: number; z: number }[],
  center: { x: number; z: number },
): number[] {
  if (points.length < 2) return [];
  const angles = points
    .map((p) => Math.atan2(p.z - center.z, p.x - center.x))
    .sort((a, b) => a - b);
  return angles.map(
    (a, i) =>
      (((angles[(i + 1) % angles.length] - a + Math.PI * 2) % (Math.PI * 2)) *
        180) /
      Math.PI,
  );
}
