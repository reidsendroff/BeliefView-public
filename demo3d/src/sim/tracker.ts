/**
 * Ground-plane constant-velocity Kalman tracker.
 *
 * INPUT CONTRACT: this module imports nothing from the world / subject / sensor code.
 * Its only inputs are `update(obs)` (a noisy fix) and `predict(dt)` (time passing).
 * While the target is unseen it only extrapolates from past observations.
 *
 * Because measurement noise is isotropic and the model is identical on x and z,
 * one shared 2x2 covariance [[pp, pv],[pv, vv]] describes both axes.
 * Illustrative 3D-demo model: NOT the frozen BeliefView v2 filter and not a validated estimator.
 */
import type { Observation, TrackStatus, TrackerSnapshot } from "./types";

export const TRACKER = {
  accelSigma: 1.1, // process noise: assumed 1-sigma walker acceleration (m/s^2)
  coastAfter: 0.5, // s without a fix before status leaves TRACKING
  searchAfter: 1.5, // s without a fix before status becomes SEARCHING
  confirmHits: 3, // consecutive fixes needed to leave REACQUIRING
  initVelVar: 4,
};

export class Tracker {
  private x = 0;
  private z = 0;
  private vx = 0;
  private vz = 0;
  private pp = 0;
  private pv = 0;
  private vv = 0;
  private inited = false;
  private age = 0;
  private hits = 0;
  private wasLost = false;

  predict(dt: number): void {
    if (!this.inited) return;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const q = TRACKER.accelSigma * TRACKER.accelSigma;
    const pp = this.pp + dt * (2 * this.pv + dt * this.vv) + (q * dt ** 4) / 4;
    const pv = this.pv + dt * this.vv + (q * dt ** 3) / 2;
    const vv = this.vv + q * dt * dt;
    this.pp = pp; this.pv = pv; this.vv = vv;
    this.age += dt;
    if (this.age > TRACKER.searchAfter) { this.wasLost = true; this.hits = 0; }
    else if (this.age > TRACKER.coastAfter) this.hits = 0;
  }

  update(obs: Observation): void {
    const R = obs.sigma * obs.sigma;
    if (!this.inited) {
      this.x = obs.x; this.z = obs.z; this.vx = 0; this.vz = 0;
      this.pp = R; this.pv = 0; this.vv = TRACKER.initVelVar;
      this.inited = true;
    } else {
      const S = this.pp + R;
      const k0 = this.pp / S, k1 = this.pv / S;
      const ix = obs.x - this.x, iz = obs.z - this.z;
      this.x += k0 * ix; this.z += k0 * iz;
      this.vx += k1 * ix; this.vz += k1 * iz;
      const pp = (1 - k0) * this.pp;
      const pv = (1 - k0) * this.pv;
      const vv = this.vv - k1 * this.pv;
      this.pp = pp; this.pv = pv; this.vv = vv;
    }
    this.age = 0;
    this.hits += 1;
    if (this.hits >= TRACKER.confirmHits) this.wasLost = false;
  }

  status(): TrackStatus {
    if (this.wasLost) return this.hits > 0 ? "REACQUIRING" : "SEARCHING";
    if (this.age > TRACKER.searchAfter) return "SEARCHING";
    if (this.age > TRACKER.coastAfter) return "COASTING";
    return "TRACKING";
  }

  snapshot(): TrackerSnapshot {
    const sigma = Math.sqrt(Math.max(this.pp, 0));
    return {
      initialised: this.inited,
      x: this.x, z: this.z, vx: this.vx, vz: this.vz,
      sigma, radius: 2.447 * sigma, age: this.age, hits: this.hits, status: this.status(),
    };
  }
}

export interface CorridorPoint {
  dt: number;
  x: number;
  z: number;
  radius: number;
}

/** Pure forward propagation of the current belief (no new observations): the prediction corridor. */
export function predictCorridor(s: TrackerSnapshot, horizon: number, steps: number): CorridorPoint[] {
  const out: CorridorPoint[] = [];
  let pp = s.sigma * s.sigma;
  // velocity variance is not in the snapshot; re-derive a conservative growth from process noise only
  const q = TRACKER.accelSigma ** 2;
  let pv = 0, vv = TRACKER.initVelVar * 0.15;
  const h = horizon / steps;
  for (let i = 0; i <= steps; i++) {
    const dt = i * h;
    out.push({ dt, x: s.x + s.vx * dt, z: s.z + s.vz * dt, radius: 2.447 * Math.sqrt(pp) });
    const npp = pp + h * (2 * pv + h * vv) + (q * h ** 4) / 4;
    const npv = pv + h * vv + (q * h ** 3) / 2;
    vv += q * h * h; pp = npp; pv = npv;
  }
  return out;
}
