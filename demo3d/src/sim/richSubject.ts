/** Rich-terrain subject version: original finite-state behavior, closer cover offsets and crouched torso0.65m.
 * Original subject.ts is preserved for historical training provenance. Only static map and delayed noisy drone pose are consumed.
 */
import { lineOfSight } from "./geometry";
import { Rng } from "./rng";
import type { XZ } from "./route";
import type { Vec3 } from "./types";
import type { Tree, World } from "./world";
import { isCoverPrimitive } from "./richWorld";
import {
  DronePerception,
  SUBJECT,
  type SubjectAction,
  type SubjectSnapshot,
} from "./subject";
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const hd = (ax: number, az: number, bx: number, bz: number) =>
  Math.hypot(ax - bx, az - bz);
function angDiff(a: number, b: number) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
interface CoverSpot {
  tree: number;
  x: number;
  z: number;
}

export class RichSubjectAgent {
  private rng: Rng;
  private perception: DronePerception;
  private x: number;
  private z: number;
  private y: number;
  private heading: number;
  private speed = 0;
  private turnRate = 0;
  private crouch = 0;
  private gait = 0;
  private action: SubjectAction = "TRAVEL";
  private actT = 0;
  private t = 0;
  private percept: Vec3 | null = null;
  private goalIdx = 1;
  private cover: CoverSpot | null = null;
  private coverSince = -1e9;
  private lastFeint = -1e9;
  private startleAt: number;
  private sprintDur = 0;
  private sprintSpeed = SUBJECT.sprintMax;
  private jinkOffset = 0;
  private jinkSign = 1;
  private nextJink = 0;
  private jinkFlash = 0;
  private feintStage = 0;
  private feintBase = 0;
  private feintSign = 1;
  private holdDur = 0;
  private resumeSign = 1;
  private coverReplan = 0;
  private coverFails = 0;
  private banned = new Set<number>();
  private bestD = 1e9;
  private bestDT = 0;

  constructor(
    private world: World,
    private goals: XZ[],
    seed: number,
    dt: number,
  ) {
    this.rng = new Rng(seed);
    this.perception = new DronePerception(this.rng, dt);
    this.x = goals[0][0];
    this.z = goals[0][1];
    this.y = world.heightAt(this.x, this.z);
    this.heading = Math.atan2(goals[1][0] - this.x, goals[1][1] - this.z);
    this.speed = SUBJECT.jogSpeed;
    this.startleAt = this.rng.range(3.4, 4.6); // when it first notices the drone (it is oblivious before that)
  }

  snapshot(): SubjectSnapshot {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      heading: this.heading,
      speed: this.speed,
      action: this.action,
      crouch: this.crouch,
      gait: this.gait,
      turnRate: this.turnRate,
      cover:
        this.action === "HIDE" || this.action === "SEEK_COVER"
          ? (this.cover?.tree ?? -1)
          : -1,
      percept: this.percept ? { ...this.percept } : null,
    };
  }

  /** Advance one fixed step. `drone` is the drone's pose at the START of the step; the agent sees it only via DronePerception. */
  step(drone: Vec3, dt: number): void {
    // null = cue lost (delayed drone beyond perceptionRange); do not retain a stale cue
    this.percept = this.perception.observe(drone, { x: this.x, z: this.z });
    this.t += dt;
    this.actT += dt;
    this.jinkFlash = Math.max(0, this.jinkFlash - dt);
    this.decide(dt);
    const { want, vWant } = this.steer(dt);
    this.integrate(want, vWant, dt);
  }

  // ------------------------------------------------------------------ decisions
  private enter(a: SubjectAction): void {
    this.action = a;
    this.actT = 0;
    const r = this.rng;
    if (a === "SPRINT" || a === "RESUME") {
      this.sprintSpeed = r.range(SUBJECT.sprintMin, SUBJECT.sprintMax);
      this.nextJink = r.range(0.9, 1.8);
      if (a === "SPRINT") this.sprintDur = r.range(4.5, 6.5);
      if (a === "RESUME") {
        this.sprintDur = r.range(1.8, 2.8);
        this.resumeSign = r.next() < 0.5 ? -1 : 1;
      }
    }
    if (a === "FEINT") {
      this.feintStage = 0;
      this.feintBase = this.heading;
      this.feintSign = this.clearerSide();
      this.lastFeint = this.t;
    }
    if (a === "HIDE") {
      this.holdDur = r.range(3.0, 5.0);
      this.coverSince = this.t;
    }
    if (a === "SEEK_COVER") {
      this.coverReplan = 0;
      this.coverFails = 0;
      this.banned.clear();
      this.bestD = hd(this.cover!.x, this.cover!.z, this.x, this.z);
      this.bestDT = 0;
    }
  }

  private decide(dt: number): void {
    const p = this.percept;
    const dDrone = p ? hd(p.x, p.z, this.x, this.z) : Infinity;
    switch (this.action) {
      case "TRAVEL":
        if (p && this.t >= this.startleAt) {
          this.enter("SPRINT");
          this.sprintDur = this.rng.range(4.5, 6.0);
        }
        break;
      case "SPRINT":
      case "JINK": {
        this.nextJink -= dt;
        if (this.nextJink <= 0) this.newJink();
        this.action = this.jinkFlash > 0 ? "JINK" : "SPRINT";
        if (this.actT >= this.sprintDur) {
          const canFeint = this.t - this.lastFeint > 10;
          const canCover = this.t - this.coverSince > 14;
          const spot = canCover && p ? this.findCover() : null;
          if (canFeint && p && dDrone < 26 && (!spot || this.rng.next() < 0.5))
            this.enter("FEINT");
          else if (spot) {
            this.cover = spot;
            this.enter("SEEK_COVER");
          } else if (canFeint && p) this.enter("FEINT");
          else this.sprintDur += 1.5;
        }
        break;
      }
      case "FEINT":
        if (this.feintStage === 0 && this.actT > 0.9) this.feintStage = 1;
        if (this.actT > 2.4) {
          this.enter("SPRINT");
          this.sprintDur = this.rng.range(2.5, 4.0);
        }
        break;
      case "SEEK_COVER": {
        this.coverReplan -= dt;
        if (this.coverReplan <= 0) {
          this.coverReplan = 0.4;
          // stick with the chosen spot while it still shields us from the perceived drone; otherwise re-pick
          if (!this.coverStillGood()) {
            const next = p ? this.findCover(this.cover?.tree ?? -1) : null;
            if (next) this.cover = next;
            else {
              this.cover = null;
              this.enter("SPRINT");
              this.sprintDur = this.rng.range(2.0, 3.0);
              break;
            }
          }
        }
        const c = this.cover!;
        const d = hd(c.x, c.z, this.x, this.z);
        if (d < this.bestD - 0.5) {
          this.bestD = d;
          this.bestDT = this.actT;
        } else if (this.actT - this.bestDT > 2.5) {
          // making no progress (boxed in by trunks): give up on this tree and look for another
          this.banned.add(c.tree);
          const next = this.findCover(-1);
          if (next) {
            this.cover = next;
            this.bestD = hd(next.x, next.z, this.x, this.z);
            this.bestDT = this.actT;
          } else {
            this.cover = null;
            this.enter("SPRINT");
            this.sprintDur = this.rng.range(2.0, 3.0);
            break;
          }
        }
        if (d < 0.9 && this.speed < 2.4) {
          if (this.coverStillGood() && this.shielded(this.x, this.z, p!, false))
            this.enter("HIDE");
          else if (++this.coverFails > 2) {
            this.cover = null;
            this.enter("SPRINT");
            this.sprintDur = this.rng.range(2.0, 3.0);
          }
        } else if (this.actT > 10) {
          this.cover = null;
          this.enter("SPRINT");
          this.sprintDur = this.rng.range(2.0, 3.0);
        }
        break;
      }
      case "HIDE": {
        const flushed = p !== null && dDrone < 10;
        const broken = !this.coverStillGood();
        if (
          this.actT >= SUBJECT.hideMin &&
          (this.actT >= this.holdDur || flushed || broken)
        )
          this.enter("RESUME");
        break;
      }
      case "RESUME":
        this.nextJink -= dt;
        if (this.nextJink <= 0) this.newJink();
        if (this.actT >= this.sprintDur) {
          this.enter("SPRINT");
          this.sprintDur = this.rng.range(4.0, 6.0);
        }
        break;
    }
  }

  private newJink(): void {
    const r = this.rng;
    this.jinkSign = r.next() < 0.8 ? -this.jinkSign : this.jinkSign;
    this.jinkOffset = this.jinkSign * r.range(0.6, 1.25); // 35-70 deg
    this.nextJink = r.range(1.3, 2.7);
    this.jinkFlash = 0.8;
  }

  /** Which side (+1 left / -1 right) has more open ground a few metres ahead, so the feint does not run into a trunk. */
  private clearerSide(): number {
    const score = (s: number) => {
      let best = 99;
      for (const a of [0.7, 1.4, 2.3]) {
        const h = this.heading + s * a;
        const px = this.x + Math.sin(h) * 5,
          pz = this.z + Math.cos(h) * 5;
        for (const t of this.world.trees) {
          if (Math.abs(t.x - px) > 8 || Math.abs(t.z - pz) > 8) continue;
          best = Math.min(best, hd(t.x, t.z, px, pz) - t.trunkR);
        }
      }
      return best;
    };
    const l = score(1),
      r = score(-1);
    if (Math.abs(l - r) < 0.3) return this.rng.next() < 0.5 ? 1 : -1;
    return l > r ? 1 : -1;
  }

  // ------------------------------------------------------------------ cover
  /** Spot behind `tree` (as seen from the perceived drone position) at horizontal offset `off` from the trunk axis. */
  private spotBehind(
    tree: Tree,
    p: Vec3,
    off: number,
  ): { x: number; z: number } {
    const dx = tree.x - p.x,
      dz = tree.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: tree.x + (dx / l) * off, z: tree.z + (dz / l) * off };
  }

  /** Is the spot shielded from the perceived drone position by tree geometry? Checked for the estimate and +-noise-sized shifts. */
  private shielded(x: number, z: number, p: Vec3, robust = true): boolean {
    const target = { x, y: this.world.heightAt(x, z) + 0.65, z };
    const dx = x - p.x,
      dz = z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    const px = -dz / l,
      pz = dx / l;
    const s = SUBJECT.perceptionNoise * 0.6;
    for (const k of robust ? [0, 1, -1] : [0]) {
      const q = { x: p.x + px * s * k, y: p.y, z: p.z + pz * s * k };
      if (lineOfSight(this.world, q, target) === "NONE") return false;
    }
    return true;
  }

  private spotFree(x: number, z: number): boolean {
    const h = this.world.half - 6;
    if (Math.abs(x) > h || Math.abs(z) > h) return false;
    const trees = this.world.trees;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      if (t.trunkR <= 0) continue;
      if (Math.abs(t.x - x) > 3 || Math.abs(t.z - z) > 3) continue;
      if (hd(t.x, t.z, x, z) < t.trunkR + SUBJECT.trunkHardMargin + 0.35)
        return false;
    }
    return true;
  }

  /** Best nearby tree to hide behind, judged only from the static map and the perceived (delayed, noisy) drone position. */
  private findCover(prefer = -1): CoverSpot | null {
    const p = this.percept;
    if (!p) return null;
    let best: CoverSpot | null = null,
      bestScore = Infinity;
    const trees = this.world.trees;
    const R = SUBJECT.coverRadius;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      if (t.trunkR <= 0) continue;
      if (Math.abs(t.x - this.x) > R || Math.abs(t.z - this.z) > R) continue;
      if (hd(t.x, t.z, this.x, this.z) > R || this.banned.has(i)) continue;
      for (const extra of [0.15, 0.45, 0.95, 1.9, 3.0]) {
        const off = t.trunkR + SUBJECT.trunkHardMargin + extra;
        const spot = this.spotBehind(t, p, off);
        if (!this.spotFree(spot.x, spot.z)) continue;
        if (!this.shielded(spot.x, spot.z, p)) continue;
        if (isCoverPrimitive(t)) {
          const own = {
            ...this.world,
            trees: this.world.trees.filter(
              (v) => isCoverPrimitive(v) && v.coverId === t.coverId,
            ),
          };
          const ownBlock = lineOfSight(own, p, {
            x: spot.x,
            y: this.world.heightAt(spot.x, spot.z) + 0.65,
            z: spot.z,
          });
          if (ownBlock !== "CANOPY" && ownBlock !== "TRUNK") continue;
        }
        // prefer short trips, small offsets, and not running toward the drone
        const trip = hd(spot.x, spot.z, this.x, this.z);
        const toward =
          hd(spot.x, spot.z, p.x, p.z) < hd(this.x, this.z, p.x, p.z) - 4
            ? 6
            : 0;
        const score = trip + extra * 0.8 + toward - (i === prefer ? 4 : 0);
        if (trip < 3.5) continue; // not a pointless hop
        if (score < bestScore) {
          bestScore = score;
          best = { tree: i, x: spot.x, z: spot.z };
        }
        break; // smallest working offset for this tree
      }
    }
    return best;
  }

  private coverStillGood(): boolean {
    const p = this.percept;
    const c = this.cover;
    if (!p || !c) return false;
    // while crouched the check is made where the subject actually is; on approach, at the chosen spot
    return this.action === "HIDE"
      ? this.shielded(this.x, this.z, p, false)
      : this.shielded(c.x, c.z, p, false);
  }

  // ------------------------------------------------------------------ steering
  private goalVec(): { x: number; z: number } {
    const g = this.goals[this.goalIdx];
    if (hd(g[0], g[1], this.x, this.z) < 7)
      this.goalIdx = (this.goalIdx + 1) % this.goals.length;
    const gg = this.goals[this.goalIdx];
    const dx = gg[0] - this.x,
      dz = gg[1] - this.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  private steer(_dt: number): { want: number; vWant: number } {
    const p = this.percept;
    const goal = this.goalVec();
    const flee = p
      ? (() => {
          const dx = this.x - p.x,
            dz = this.z - p.z,
            l = Math.hypot(dx, dz) || 1;
          return { x: dx / l, z: dz / l };
        })()
      : { x: Math.sin(this.heading), z: Math.cos(this.heading) };
    const blend = (wf: number, wg: number) =>
      Math.atan2(flee.x * wf + goal.x * wg, flee.z * wf + goal.z * wg);
    let want = this.heading,
      vWant = 0;
    switch (this.action) {
      case "TRAVEL":
        want = Math.atan2(goal.x, goal.z);
        vWant = SUBJECT.jogSpeed;
        break;
      case "SPRINT":
      case "JINK":
        want = blend(0.6, 0.4) + this.jinkOffset;
        vWant = this.sprintSpeed;
        break;
      case "FEINT":
        want =
          this.feintStage === 0
            ? this.feintBase + this.feintSign * 0.7
            : this.feintBase + this.feintSign * (0.7 - Math.PI * 0.95);
        vWant = this.sprintSpeed;
        break;
      case "RESUME":
        want = blend(0.7, 0.3) + this.resumeSign * 1.2 + this.jinkOffset * 0.5;
        vWant = this.sprintSpeed;
        break;
      case "SEEK_COVER": {
        const c = this.cover!;
        const d = hd(c.x, c.z, this.x, this.z);
        want = Math.atan2(c.x - this.x, c.z - this.z);
        vWant = clamp(d * 1.4, SUBJECT.creepSpeed, this.sprintSpeed);
        break;
      }
      case "HIDE":
        want = this.heading;
        vWant = 0;
        break;
    }
    // keep inside the map
    const edge = this.world.half - 12;
    const ox = Math.max(0, Math.abs(this.x) - edge),
      oz = Math.max(0, Math.abs(this.z) - edge);
    if (ox > 0 || oz > 0) {
      const k = Math.min(1, Math.hypot(ox, oz) / 8);
      const cx =
        Math.sin(want) * (1 - k) -
        ((Math.sign(this.x) * ox) / Math.max(ox + oz, 1e-9)) * k * 1.5;
      const cz =
        Math.cos(want) * (1 - k) -
        ((Math.sign(this.z) * oz) / Math.max(ox + oz, 1e-9)) * k * 1.5;
      want = Math.atan2(cx, cz);
    }
    want = this.avoidTrees(want);
    return { want, vWant };
  }

  /** Steering repulsion from nearby trunks (the subject sees the static trees around it). */
  private avoidTrees(want: number): number {
    const ux = Math.sin(want),
      uz = Math.cos(want);
    let vx = ux,
      vz = uz;
    const own =
      this.action === "SEEK_COVER" || this.action === "HIDE"
        ? (this.cover?.tree ?? -1)
        : -1;
    const trees = this.world.trees;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      if (t.trunkR <= 0) continue;
      const rx = t.x - this.x,
        rz = t.z - this.z;
      if (
        Math.abs(rx) > SUBJECT.avoidRange + 2 ||
        Math.abs(rz) > SUBJECT.avoidRange + 2
      )
        continue;
      const d = Math.hypot(rx, rz);
      const gap = d - t.trunkR;
      if (gap > SUBJECT.avoidRange) continue;
      if (i === own && gap > 0.5) continue;
      const ahead = (rx * ux + rz * uz) / (d || 1);
      if (ahead < -0.3) continue;
      const k =
        (1 - clamp(gap / SUBJECT.avoidRange, 0, 1)) *
        (0.4 + 0.6 * Math.max(0, ahead));
      const nx = rx / (d || 1),
        nz = rz / (d || 1);
      // slip around the trunk on the side we are already on
      const side = nx * uz - nz * ux >= 0 ? -1 : 1;
      vx += -nx * k * 1.0 + -nz * side * k * 1.2;
      vz += -nz * k * 1.0 + nx * side * k * 1.2;
    }
    return Math.atan2(vx, vz);
  }

  // ------------------------------------------------------------------ kinematics
  private integrate(want: number, vWant: number, dt: number): void {
    const err = angDiff(this.heading, want);
    const turnCap = Math.min(
      SUBJECT.maxTurnRate,
      SUBJECT.latAccel / Math.max(this.speed, 1.5),
    );
    const dPsi = clamp(err, -turnCap * dt, turnCap * dt);
    this.heading += dPsi;
    this.turnRate = dPsi / dt;
    // slow down for sharp turns (plant and cut)
    const vEff =
      vWant *
      Math.max(0.22, Math.cos(Math.min(Math.abs(err), Math.PI) / 2) ** 2);
    const dv = clamp(
      vEff - this.speed,
      -SUBJECT.decel * dt,
      SUBJECT.accel * dt,
    );
    this.speed = Math.max(0, this.speed + dv);
    const oldX = this.x,
      oldZ = this.z;
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
    // Resolve overlapping footprints repeatedly. If a narrow gap cannot be resolved
    // locally, stay at the last valid pose rather than teleporting or penetrating.
    const nearby = this.world.trees.filter(
      (t) =>
        t.trunkR > 0 &&
        Math.abs(t.x - this.x) < t.trunkR + 2 &&
        Math.abs(t.z - this.z) < t.trunkR + 2,
    );
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const t of nearby) {
        const d = hd(t.x, t.z, this.x, this.z),
          need = t.trunkR + SUBJECT.trunkHardMargin;
        if (d < need - 1e-8) {
          const nx = d > 1e-6 ? (this.x - t.x) / d : 1,
            nz = d > 1e-6 ? (this.z - t.z) / d : 0;
          this.x = t.x + nx * need;
          this.z = t.z + nz * need;
          changed = true;
        }
      }
      if (!changed) break;
    }
    const unresolved = nearby.some(
      (t) =>
        hd(t.x, t.z, this.x, this.z) <
        t.trunkR + SUBJECT.trunkHardMargin - 1e-6,
    );
    if (unresolved || hd(oldX, oldZ, this.x, this.z) > this.speed * dt + 0.08) {
      this.x = oldX;
      this.z = oldZ;
      this.speed = 0;
    }
    const lim = this.world.half - 3;
    this.x = clamp(this.x, -lim, lim);
    this.z = clamp(this.z, -lim, lim);
    this.y = this.world.heightAt(this.x, this.z);
    this.gait += this.speed * dt;
    const target =
      this.action === "HIDE"
        ? 1
        : this.action === "SEEK_COVER" &&
            this.cover &&
            hd(this.cover.x, this.cover.z, this.x, this.z) < 1.2
          ? 0.6
          : 0;
    this.crouch += clamp(
      target - this.crouch,
      -SUBJECT.crouchRate * dt,
      SUBJECT.crouchRate * dt,
    );
  }
}
