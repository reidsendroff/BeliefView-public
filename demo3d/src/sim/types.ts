export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type TrackStatus = "TRACKING" | "COASTING" | "SEARCHING" | "REACQUIRING";
export type DroneMode = "FOLLOW_HIGH" | "SEARCH" | "FOLLOW_LOW" | "CLIMB";
export type VisibilityReason = "VISIBLE" | "OCCLUDED_CANOPY" | "OCCLUDED_TRUNK" | "OCCLUDED_TERRAIN" | "OUT_OF_RANGE" | "OUT_OF_FOV";

/** The only thing the tracker ever receives. No truth, no visibility flag. */
export interface Observation {
  t: number;
  x: number;
  z: number;
  /** 1-sigma measurement noise (m) the sensor reports alongside the fix. */
  sigma: number;
}

export interface TrackerSnapshot {
  initialised: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** 1-sigma position uncertainty per axis (m). */
  sigma: number;
  /** ~95% radius of the 2D position uncertainty (m). */
  radius: number;
  /** Seconds since last accepted observation. */
  age: number;
  hits: number;
  status: TrackStatus;
}

export interface Frame {
  i: number;
  t: number;
  /** Simulated-world truth for the subject. Evaluation/rendering only: the tracker and drone never read it. */
  subject: Vec3 & {
    heading: number;
    speed: number;
    action: "TRAVEL" | "SPRINT" | "JINK" | "FEINT" | "SEEK_COVER" | "HIDE" | "RESUME";
    crouch: number;
    gait: number;
    turnRate: number;
    cover: number;
    percept: Vec3 | null;
  };
  drone: Vec3 & { yaw: number; vx: number; vy: number; vz: number; agl: number };
  cam: { yaw: number; pitch: number };
  obs: Observation | null;
  visibility: VisibilityReason;
  track: TrackerSnapshot;
  mode: DroneMode;
  viewpoint: { x: number; z: number } | null;
}
