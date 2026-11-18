/** Final reserve is inaccessible in the development prototype, regardless of caller role flags. */
export const TEAM_RESERVES = [
  [320000, 320199],
  [325000, 325199],
  [330000, 330029],
  [335000, 335029],
] as const;
export function assertNotReserved(...seeds: number[]) {
  for (const seed of seeds) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error("Seeds must be uint32 integers");
    if (TEAM_RESERVES.some(([a, b]) => seed >= a && seed <= b))
      throw new Error(
        "Untouched team audit reserve is locked until a reviewed source/protocol freeze",
      );
  }
}
