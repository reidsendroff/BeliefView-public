/** Public team-policy boundary. No simulated subject state or visibility verdict is accepted. */
import type { Observation, Vec3 } from "../sim/types";
export type SensorId = "A" | "B" | "C";
export const THREE_IDS: readonly SensorId[] = ["A", "B", "C"];
export type TeamArm = "independent" | "sector" | "shared" | "coordinated";
export interface SensorPose extends Vec3 {
  yaw: number;
  pitch: number;
}
export interface Evidence {
  readonly messageId: string;
  readonly sensorId: SensorId;
  readonly sensedAt: number;
  readonly receivedAt: number;
  readonly pose: Readonly<SensorPose>;
  readonly observation: Readonly<Observation> | null;
}
export interface PublicRegion {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export const INITIAL_REGION: PublicRegion = {
  minX: -24,
  maxX: 24,
  minZ: -12,
  maxZ: 36,
};
export const GRID = { n: 32, cell: 6, half: 96 } as const;
export const TEAM = {
  dt: 0.05,
  duration: 75,
  evidencePeriod: 0.5,
  replanPeriod: 1.5,
  separation: 4,
  initializationS: 1,
} as const;
