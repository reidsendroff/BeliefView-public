/** Strict presentation flags. Never passed to simulation or evidence updates. */
export const OVERLAY_DEFAULTS = {
  mass: true,
  predict: true,
  plans: false,
  marks: true,
  annotations: true,
  fill: false,
} as const;
export type OverlayKey = keyof typeof OVERLAY_DEFAULTS;
export type OverlayFlags = Record<OverlayKey, boolean>;
export const OVERLAY_KEYS = Object.keys(OVERLAY_DEFAULTS) as OverlayKey[];
export function overlayFlags(query: URLSearchParams): OverlayFlags {
  return Object.fromEntries(
    OVERLAY_KEYS.map((key) => [
      key,
      query.get(key) === "0"
        ? false
        : query.get(key) === "1"
          ? true
          : OVERLAY_DEFAULTS[key],
    ]),
  ) as OverlayFlags;
}

/** Compensate division roundoff at exact0.05s replay boundaries, never advance a real sub-tick. */
export function displayFrameIndex(
  time: number,
  count: number,
  dt = 0.05,
): number {
  return Math.max(0, Math.min(count - 1, Math.floor(time / dt + 1e-9)));
}
