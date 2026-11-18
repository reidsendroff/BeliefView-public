/**
 * Illustrative drone guidance + kinematics. The controller sees ONLY the tracker belief
 * (never the subject's true position) plus a known static map (trees/terrain).
 */
import { lineOfSight, projectClear } from "./geometry";
import { CAMERA } from "./sensor";
import type { DroneMode, TrackerSnapshot, Vec3 } from "./types";
import type { World } from "./world";

export const DRONE = {
  cruiseAgl: 24,
  followStandoff: 14,
  searchAgl: 3.0,
  lowFollowAgl: 3.5,
  lowFollowStandoff: 9,
  lowFollowHold: 8, // s of low follow before climbing back
  minAgl: 2.0, // hard terrain clearance
  obstacleMargin: 1.0, // hard clearance from trunks / canopies
  searchCommitAgl: 5.0, // search drops through a clear column to this AGL before travelling to a low viewpoint
  maxHSpeed: 8,
  maxVSpeed: 4.2,
  searchDescentSpeed: 3.4, // careful descent while searching for a lost subject
  maxAccel: 4,
  gimbalSlew: (75 * Math.PI) / 180,
  replan: 1.0,
  targetHeight: 1.3, // torso height above ground used for line-of-sight and gaze
};

/**
 * Optional learned search guidance (see ../ml/guidance.ts). It only ever sees the drone state, the known map and a
 * probability grid built from observations; it can only choose the search viewpoint and gaze point. Mode logic, kinematics,
 * acceleration/speed limits, terrain/obstacle clearance and gimbal slew below are unchanged and still apply to it.
 */
export interface SearchGuidance {
  /** Called on each SEARCH replan. Return null to fall back to the Kalman-belief viewpoint. */
  chooseViewpoint(world: World, d: DroneState): { x: number; z: number } | null;
  /** Ground point the gimbal should look at while searching; null keeps the default belief sweep. */
  gazeTarget(): { x: number; z: number } | null;
}

export interface DroneState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  camYaw: number;
  camPitch: number;
  mode: DroneMode;
  modeT: number;
  viewpoint: { x: number; z: number } | null;
  replanT: number;
  lastDir: { x: number; z: number };
  wasSearching: boolean;
  descentCol: { x: number; z: number } | null;
}

function angDiff(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function makeDrone(world: World, start: { x: number; z: number }, aimAt: { x: number; z: number }): DroneState {
  const y = world.heightAt(start.x, start.z) + DRONE.cruiseAgl;
  const dx = aimAt.x - start.x, dz = aimAt.z - start.z;
  const g = world.heightAt(aimAt.x, aimAt.z) + DRONE.targetHeight;
  return {
    pos: { x: start.x, y, z: start.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: Math.atan2(dx, dz),
    camYaw: Math.atan2(dx, dz),
    camPitch: Math.atan2(g - y, Math.hypot(dx, dz)),
    mode: "FOLLOW_HIGH",
    modeT: 0,
    viewpoint: null,
    replanT: 0,
    lastDir: { x: dx / Math.hypot(dx, dz), z: dz / Math.hypot(dx, dz) },
    wasSearching: false,
    descentCol: null,
  };
}

/** Choose a low viewpoint around the belief with the best predicted line of sight into the belief ellipse. */
function chooseViewpoint(world: World, d: DroneState, b: TrackerSnapshot): { x: number; z: number } {
  const targetPts: Vec3[] = [];
  const spread = Math.min(Math.max(b.radius * 0.6, 1.5), 12);
  const offs: [number, number][] = [[0, 0], [spread, 0], [-spread, 0], [0, spread], [0, -spread]];
  for (const [ox, oz] of offs) {
    const x = b.x + ox, z = b.z + oz;
    targetPts.push({ x, y: world.heightAt(x, z) + DRONE.targetHeight, z });
  }
  let best = { x: d.pos.x, z: d.pos.z }, bestScore = -Infinity;
  for (const radius of [7, 12, 18]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      const cx = b.x + Math.cos(a) * radius, cz = b.z + Math.sin(a) * radius;
      const p = { x: cx, y: world.heightAt(cx, cz) + DRONE.searchAgl, z: cz };
      const q = { ...p };
      if (projectClear(world, q, DRONE.obstacleMargin, DRONE.minAgl) && Math.hypot(q.x - p.x, q.z - p.z, q.y - p.y) > 0.01) continue;
      let vis = 0;
      for (const tp of targetPts) {
        if (Math.hypot(tp.x - p.x, tp.y - p.y, tp.z - p.z) <= CAMERA.maxRange && lineOfSight(world, p, tp) === "NONE") vis++;
      }
      let score = (10 * vis) / targetPts.length - 0.04 * Math.hypot(cx - d.pos.x, cz - d.pos.z) - Math.abs(radius - 12) * 0.05;
      if (d.viewpoint && Math.hypot(d.viewpoint.x - cx, d.viewpoint.z - cz) < 1) score += 1.5;
      if (score > bestScore) { bestScore = score; best = { x: cx, z: cz }; }
    }
  }
  return best;
}

/** Is the vertical column above (x, y, z) up to cruise altitude free of canopy/trunk? */
export function columnClear(world: World, x: number, z: number, y: number): boolean {
  const top = world.heightAt(x, z) + DRONE.cruiseAgl;
  if (y >= top) return true;
  const a = { x, y, z }, b = { x, y: top, z };
  const inflate = DRONE.obstacleMargin;
  for (const t of world.trees) {
    if (Math.abs(t.x - x) > t.canopyR + inflate + 0.5 || Math.abs(t.z - z) > t.canopyR + inflate + 0.5) continue;
    if (Math.hypot(t.x - x, t.z - z) < t.canopyR + inflate && t.canopyY + t.canopyR > y) return false;
  }
  return lineOfSight(world, a, b) === "NONE";
}

/** Is the vertical column from (x, y, z) down to `yLow` free of canopy/trunk (with margin)? */
export function descentClear(world: World, x: number, z: number, y: number, yLow: number): boolean {
  if (y <= yLow) return true;
  const inflate = DRONE.obstacleMargin + 0.5;
  for (const t of world.trees) {
    if (Math.hypot(t.x - x, t.z - z) < t.canopyR + inflate && t.canopyY - t.canopyR < y + 1 && t.canopyY + t.canopyR > yLow) return false;
  }
  return lineOfSight(world, { x, y, z }, { x, y: yLow, z }) === "NONE";
}

/** Open column closest to `anchor` (the believed subject position) through which the drone can drop to search height. */
function nearestDescentColumn(world: World, anchor: { x: number; z: number }, y: number): { x: number; z: number } {
  const low = (x: number, z: number) => world.heightAt(x, z) + DRONE.searchCommitAgl;
  if (descentClear(world, anchor.x, anchor.z, y, low(anchor.x, anchor.z))) return { x: anchor.x, z: anchor.z };
  for (const r of [2, 4, 6, 8, 11, 14, 18]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      const x = anchor.x + Math.cos(a) * r, z = anchor.z + Math.sin(a) * r;
      if (descentClear(world, x, z, y, low(x, z))) return { x, z };
    }
  }
  return { x: anchor.x, z: anchor.z };
}

function nearestClearColumn(world: World, p: Vec3): { x: number; z: number } {
  let best = { x: p.x, z: p.z }, bd = Infinity;
  for (const r of [3, 6, 9, 13, 18]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      const q = { x, y: world.heightAt(x, z) + DRONE.lowFollowAgl, z };
      if (projectClear(world, q, DRONE.obstacleMargin, DRONE.minAgl)) continue;
      if (columnClear(world, x, z, q.y) && r < bd) { bd = r; best = { x, z }; }
    }
    if (bd < Infinity) break;
  }
  return best;
}

export function stepDrone(world: World, d: DroneState, b: TrackerSnapshot, aimHint: { x: number; z: number }, t: number, dt: number, guidance?: SearchGuidance): void {
  const status = b.status;
  const believed = b.initialised ? { x: b.x, z: b.z } : aimHint;
  d.modeT += dt;

  // ---- mode logic: driven only by tracker status (itself derived from observations) ----
  const setMode = (m: DroneMode) => { if (d.mode !== m) { d.mode = m; d.modeT = 0; } };
  if (status === "SEARCHING" || status === "REACQUIRING") { setMode("SEARCH"); d.wasSearching = true; }
  else if (d.mode === "SEARCH" && status === "TRACKING") { setMode("FOLLOW_LOW"); }
  else if (d.mode === "FOLLOW_LOW" && d.modeT > DRONE.lowFollowHold) setMode("CLIMB");
  else if (d.mode === "CLIMB" && d.pos.y - world.heightAt(d.pos.x, d.pos.z) > DRONE.cruiseAgl - 1.5) setMode("FOLLOW_HIGH");

  // heading of belief for standoff placement
  const sp = Math.hypot(b.vx, b.vz);
  if (b.initialised && sp > 0.4) { d.lastDir = { x: b.vx / sp, z: b.vz / sp }; }

  let tx: number, tz: number, tAgl: number;
  if (d.mode === "SEARCH") {
    d.replanT -= dt;
    if (!d.viewpoint || d.replanT <= 0) {
      d.viewpoint = guidance?.chooseViewpoint(world, d) ?? chooseViewpoint(world, d, { ...b, x: believed.x, z: believed.z });
      d.replanT = DRONE.replan;
    }
    tx = d.viewpoint.x; tz = d.viewpoint.z; tAgl = DRONE.searchAgl;
    // Descend first: travel (at altitude) to an open column near the believed position, drop through it to search
    // height, then move sideways at low altitude.
    const agl = d.pos.y - world.heightAt(d.pos.x, d.pos.z);
    if (agl > DRONE.searchCommitAgl + 0.5) {
      const lowY = (x: number, z: number) => world.heightAt(x, z) + DRONE.searchCommitAgl;
      if (!d.descentCol || !descentClear(world, d.descentCol.x, d.descentCol.z, d.pos.y, lowY(d.descentCol.x, d.descentCol.z))) {
        d.descentCol = nearestDescentColumn(world, d.pos, d.pos.y);
      }
      tx = d.descentCol.x; tz = d.descentCol.z;
      if (Math.hypot(tx - d.pos.x, tz - d.pos.z) > 2.5) tAgl = Math.max(agl, DRONE.searchAgl + 6);
    } else d.descentCol = null;
  } else if (d.mode === "CLIMB" && !columnClear(world, d.pos.x, d.pos.z, d.pos.y)) {
    // Canopy overhead: slide sideways to the nearest open column before climbing.
    d.viewpoint = null;
    const gap = nearestClearColumn(world, { x: believed.x - d.lastDir.x * DRONE.lowFollowStandoff, y: d.pos.y, z: believed.z - d.lastDir.z * DRONE.lowFollowStandoff });
    tx = gap.x; tz = gap.z; tAgl = DRONE.lowFollowAgl;
  } else {
    d.viewpoint = null;
    const standoff = d.mode === "FOLLOW_LOW" ? DRONE.lowFollowStandoff : DRONE.followStandoff;
    tx = believed.x - d.lastDir.x * standoff;
    tz = believed.z - d.lastDir.z * standoff;
    tAgl = d.mode === "FOLLOW_LOW" ? DRONE.lowFollowAgl : DRONE.cruiseAgl;
  }
  const targetY = world.heightAt(tx, tz) + tAgl;

  // ---- kinematics (velocity-limited, acceleration-limited) ----
  let wvx = (tx - d.pos.x) * 0.9, wvz = (tz - d.pos.z) * 0.9;
  const hs = Math.hypot(wvx, wvz);
  if (hs > DRONE.maxHSpeed) { wvx *= DRONE.maxHSpeed / hs; wvz *= DRONE.maxHSpeed / hs; }
  const downLim = d.mode === "SEARCH" ? DRONE.searchDescentSpeed : DRONE.maxVSpeed;
  const wvy = Math.max(-downLim, Math.min(DRONE.maxVSpeed, (targetY - d.pos.y) * 1.1));
  let ax = wvx - d.vel.x, ay = wvy - d.vel.y, az = wvz - d.vel.z;
  const am = Math.hypot(ax, ay, az), lim = DRONE.maxAccel * dt;
  if (am > lim) { ax *= lim / am; ay *= lim / am; az *= lim / am; }
  d.vel.x += ax; d.vel.y += ay; d.vel.z += az;
  d.pos.x += d.vel.x * dt; d.pos.y += d.vel.y * dt; d.pos.z += d.vel.z * dt;
  const before = { ...d.pos };
  if (projectClear(world, d.pos, DRONE.obstacleMargin, DRONE.minAgl)) {
    // remove velocity pushing into the obstacle
    d.vel.x += (d.pos.x - before.x) / dt * 0.2;
    d.vel.y += (d.pos.y - before.y) / dt * 0.2;
    d.vel.z += (d.pos.z - before.z) / dt * 0.2;
  }
  if (Math.hypot(d.vel.x, d.vel.z) > 0.6) {
    const want = Math.atan2(d.vel.x, d.vel.z);
    d.yaw += Math.max(-2 * dt, Math.min(2 * dt, angDiff(d.yaw, want)));
  }

  // ---- gimbal: aim at belief (with a lateral sweep while searching) ----
  let gx = believed.x, gz = believed.z;
  if (d.mode === "SEARCH") {
    const learned = guidance?.gazeTarget() ?? null;
    if (learned) { gx = learned.x; gz = learned.z; }
    else {
      const rx = believed.x - d.pos.x, rz = believed.z - d.pos.z;
      const rl = Math.hypot(rx, rz) || 1;
      const sweep = Math.min(Math.max(b.radius * 0.8, 2), 12) * Math.sin(0.85 * t);
      gx += (-rz / rl) * sweep; gz += (rx / rl) * sweep;
    }
  }
  const gy = world.heightAt(gx, gz) + DRONE.targetHeight;
  const wantYaw = Math.atan2(gx - d.pos.x, gz - d.pos.z);
  const wantPitch = Math.max(-1.5, Math.min(0.2, Math.atan2(gy - d.pos.y, Math.hypot(gx - d.pos.x, gz - d.pos.z))));
  const slew = DRONE.gimbalSlew * dt;
  d.camYaw += Math.max(-slew, Math.min(slew, angDiff(d.camYaw, wantYaw)));
  d.camPitch += Math.max(-slew, Math.min(slew, wantPitch - d.camPitch));
}
