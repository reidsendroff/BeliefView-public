/**
 * Render-only cinematic spectator framing. Pure functions of the recorded Timeline and the playback time `t`
 * (no hidden state), so playback and scrubbing give the same shot. Nothing here feeds back into the simulation,
 * the observations or the tracker; it only decides where the evaluation-only spectator camera sits.
 */
import { lineOfSight } from "../sim/geometry";
import { lerp, sampleAt } from "../sim/playback";
import type { Frame } from "../sim/types";
import type { World } from "../sim/world";

export type ShotKind = "RUN" | "HIDE";

/** Recorded subject actions that earn a close spectator shot. */
const SHOT_OF: Partial<Record<Frame["subject"]["action"], ShotKind>> = {
  SPRINT: "RUN", JINK: "RUN", FEINT: "RUN", SEEK_COVER: "RUN", HIDE: "HIDE", RESUME: "HIDE",
};

const HALF_WINDOW = 1.8; // s of look-ahead/behind used to ease in and out
const TAPS = 18;

export interface Focus {
  /** 0 = wide story shot, 1 = full close shot. */
  w: number;
  kind: ShotKind;
}

/** Smoothed 0..1 weight of the close shot at time t (triangular window over the recorded actions). Deterministic in t. */
export function closeShotFocus(frames: Frame[], t: number): Focus {
  let wRun = 0, wHide = 0, norm = 0;
  for (let k = -TAPS; k <= TAPS; k++) {
    const k01 = 1 - Math.abs(k) / (TAPS + 1);
    const f = sampleAt(frames, t + (k / TAPS) * HALF_WINDOW).a;
    const kind = SHOT_OF[f.subject.action];
    // A lost track (tracker status) is exactly when a human viewer needs to see what the subject is doing.
    const boost = f.track.status === "TRACKING" ? 1 : 1.15;
    if (kind === "RUN") wRun += k01 * boost; else if (kind === "HIDE") wHide += k01 * boost;
    norm += k01;
  }
  const w = Math.min(1, (wRun + wHide) / norm);
  const e = w * w * (3 - 2 * w);
  return { w: e, kind: wHide > wRun ? "HIDE" : "RUN" };
}

export interface CloseShot {
  pos: { x: number; y: number; z: number };
  look: { x: number; y: number; z: number };
}

/**
 * Pick a nearby spectator viewpoint around the subject: candidate bearings/radii relative to the shot axis are scored by
 * line of sight to the subject's torso, trunk clearance along the sight line, and a fixed preference order, so the choice is a pure function of the frame.
 * RUN axis = heading (side/three-quarter views show the gait). HIDE axis = tree->subject, viewed from the side so tree and crouched person both read.
 */
export function closeShot(world: World, f: Frame, kind: ShotKind): CloseShot {
  const s = f.subject;
  const gy = world.heightAt(s.x, s.z);
  const tree = kind === "HIDE" && s.cover >= 0 ? world.trees[s.cover] : undefined;
  const axis = tree ? Math.atan2(s.x - tree.x, s.z - tree.z) : s.heading;
  const radii = [6.5, 8, 5.2];
  const chestH = kind === "HIDE" ? 0.75 : 1.05;
  const chest = { x: s.x, y: gy + chestH, z: s.z };
  // Preference order: side views first (best read of gait / of tree + crouched person), then three-quarter, then end-on.
  const degs = kind === "HIDE"
    ? [90, -90, 60, -60, 120, -120, 30, -30, 150, -150]
    : [90, -90, 125, -125, 55, -55, 160, -160, 20, -20];
  let best = { score: Infinity, x: 0, z: 0 };
  radii.forEach((R, ri) => degs.forEach((d, di) => {
    const a = axis + (d * Math.PI) / 180;
    const x = s.x + Math.sin(a) * R, z = s.z + Math.cos(a) * R;
    const eye = { x, y: world.heightAt(x, z) + 1.6, z };
    let score = di * 0.15 + ri * 0.3;
    if (lineOfSight(world, eye, chest) !== "NONE") score += 10;
    // Trunk clearance along the sight line (so a trunk beside the line does not clip the person) and around the eye.
    const dx = s.x - x, dz = s.z - z, l2 = dx * dx + dz * dz;
    for (const t of world.trees) {
      if (Math.abs(t.x - s.x) > 14 || Math.abs(t.z - s.z) > 14) continue;
      const own = tree === t;
      const u = Math.min(own ? 0.8 : 0.93, Math.max(0, ((t.x - x) * dx + (t.z - z) * dz) / l2));
      const clear = Math.hypot(x + dx * u - t.x, z + dz * u - t.z) - t.trunkR;
      if (clear < 0.9) score += (0.9 - clear) * 6;
      if (Math.hypot(t.x - x, t.z - z) < t.trunkR + 1.2) score += 6;
    }
    if (score < best.score) best = { score, x, z };
  }));
  const gx = world.heightAt(best.x, best.z);
  // look slightly toward the drone so the story is not lost, but keep the person centred
  const bias = 0.1;
  return {
    pos: { x: best.x, y: gx + 1.6, z: best.z },
    look: { x: s.x + (f.drone.x - s.x) * bias, y: gy + chestH + (f.drone.y - gy - chestH) * 0.04, z: s.z + (f.drone.z - s.z) * bias },
  };
}

/* ---- Stable continuous close-up rig -------------------------------------------------------------------------------
 * closeShot() above re-runs a hard argmin over candidate bearings every frame, so its viewpoint can jump between
 * candidates when a score ties or LOS flips. closeShotRig() is the pure-in-t replacement used by the Cinematic mode:
 * a Viterbi-selected obstruction-aware angular track around the smoothed subject-to-drone bearing (no per-frame
 * argmin and no RUN/HIDE switch), orbiting the time-smoothed subject position. Everything is a windowed average of the recorded
 * Timeline, hence continuous, deterministic under random access, and independent of render frame rate. */
const RIG_POS_HALF = 0.9; // s, subject-position smoothing (removes jink/feint jitter from the camera position)
const RIG_AXIS_HALF = 4; // s, shot-axis smoothing (turns and RUN<->HIDE axis changes become slow orbits)
const RIG_SIDE = Math.PI / 2;
const RIG_EYE = 1.6;

/** Fixed-step frames interpolated at t (sampleAt alone returns the earlier frame, which would make the rig stair-step). */
function interp(frames: Frame[], t: number) {
  const { a, b, u } = sampleAt(frames, t);
  return {
    sx: lerp(a.subject.x, b.subject.x, u), sz: lerp(a.subject.z, b.subject.z, u), heading: Math.atan2(lerp(a.drone.x, b.drone.x, u) - lerp(a.subject.x, b.subject.x, u), lerp(a.drone.z, b.drone.z, u) - lerp(a.subject.z, b.subject.z, u)),
    hd: Math.hypot(lerp(a.drone.x, b.drone.x, u) - lerp(a.subject.x, b.subject.x, u), lerp(a.drone.z, b.drone.z, u) - lerp(a.subject.z, b.subject.z, u)),
    dx: lerp(a.drone.x, b.drone.x, u), dy: lerp(a.drone.y, b.drone.y, u), dz: lerp(a.drone.z, b.drone.z, u),
  };
}

interface RigBase { px: number; pz: number; dx: number; dy: number; dz: number; axis: number; sx: number; sz: number }

/** Time-smoothed subject position, drone position and shot axis at t (pure function of frames and t). */
function rigBase(frames: Frame[], t: number): RigBase {
  let px = 0, pz = 0, dx = 0, dy = 0, dz = 0, pn = 0;
  const PT = Math.max(12, Math.ceil(RIG_POS_HALF / (frames[1].t - frames[0].t))); // tap spacing <= frame step, so discrete taps do not ripple
  for (let k = -PT; k <= PT; k++) {
    const w = 1 - Math.abs(k) / (PT + 1);
    const f = interp(frames, t + (k / PT) * RIG_POS_HALF);
    px += f.sx * w; pz += f.sz * w;
    dx += f.dx * w; dy += f.dy * w; dz += f.dz * w; pn += w;
  }
  px /= pn; pz /= pn; dx /= pn; dy /= pn; dz /= pn;

  // Hat-weighted mean of the heading ANGLE, unwrapped outward from t (a vector average cancels on hairpin turns and
  // then swings the camera through the null; an unwrapped angle mean has a bounded turn rate).
  const AT = Math.max(16, Math.ceil(RIG_AXIS_HALF / (frames[1].t - frames[0].t)));
  const h0 = interp(frames, t).heading;
  let hs = 0, hn = 0;
  for (const dir of [1, -1]) {
    let prev = h0;
    for (let k = dir === 1 ? 0 : 1; k <= AT; k++) {
      const f = interp(frames, t + dir * (k / AT) * RIG_AXIS_HALF);
      const h = f.heading;
      // Overhead drone: bearing is ill-defined, so its weight fades out (hold the unwrapped angle, count nothing).
      const near = Math.min(1, Math.max(0, (f.hd - 2) / 6));
      if (near > 0) prev += Math.atan2(Math.sin(h - prev), Math.cos(h - prev));
      const w = (1 - k / (AT + 1)) * near;
      hs += (prev - h0) * w; hn += w;
    }
  }
  const cur = interp(frames, t);
  return { px, pz, dx, dy, dz, axis: (hn > 1e-6 ? h0 + hs / hn : h0) + RIG_SIDE, sx: cur.sx, sz: cur.sz };
}

/* ---- Obstruction-aware viewpoint track -----------------------------------------------------------------------------
 * The side offset (angle around the subject + radius) is chosen by a Viterbi search over the whole timeline, not per
 * frame: each node scores line of sight to the runner's torso/head, trunk clearance on the sight line, trunks
 * crowding the camera, and trunks in the foreground of the view cone that would fill the frame. Transitions are limited
 * to one grid step per node (plus a cost), so the chosen path cannot teleport; it is then hat-smoothed. The path
 * depends only on (world, frames), is cached, and is queried by interpolation, so it stays a pure function of t. */
const NODE_DT = 0.1; // s between Viterbi nodes
const OFF_STEP = Math.PI / 18; // 10 degree margin probe
const OFF_N = 120; // candidate offsets: 3 degree steps around the subject (max orbit rate = 1 step / node = 0.52 rad/s)
const RADII = [6.5, 5.2, 8];
const SMOOTH_NODES = 6; // hat half-width of the path smoothing, in nodes (0.6 s)
const CHEST = 1.0, HEAD = 1.6;

interface RigTrack { off: Float64Array; rad: Float64Array }
const trackCache = new WeakMap<Frame[], WeakMap<World, RigTrack>>();

function nodeCost(world: World, b: RigBase, offIdx: number, ri: number): number {
  const off = ((offIdx - OFF_N / 2) * 2 * Math.PI) / OFF_N; // -pi .. pi - step, 0 = side shot
  const R = RADII[ri], a = b.axis + off;
  const x = b.px + Math.sin(a) * R, z = b.pz + Math.cos(a) * R;
  const eye = { x, y: world.heightAt(x, z) + RIG_EYE, z };
  const gy = world.heightAt(b.sx, b.sz);
  let c = Math.abs(off) * 0.9 + ri * 0.3; // prefer the side view, then the nearer radius
  if (lineOfSight(world, eye, { x: b.sx, y: gy + CHEST, z: b.sz }) !== "NONE") c += 10;
  if (lineOfSight(world, eye, { x: b.sx, y: gy + HEAD, z: b.sz }) !== "NONE") c += 6;
  // Margin: the smoothed path sweeps between grid angles and the runner moves between nodes, so also penalise a
  // viewpoint whose angular neighbours (+-1 step) are obstructed.
  for (const dOff of [-OFF_STEP, OFF_STEP]) {
    const na = a + dOff, nx = b.px + Math.sin(na) * R, nz = b.pz + Math.cos(na) * R;
    if (lineOfSight(world, { x: nx, y: world.heightAt(nx, nz) + RIG_EYE, z: nz }, { x: b.sx, y: gy + CHEST, z: b.sz }) !== "NONE") c += 3;
  }
  const dx = b.sx - x, dz = b.sz - z, dist = Math.hypot(dx, dz) || 1, l2 = dist * dist;
  const yaw = Math.atan2(dx, dz);
  for (const t of world.trees) {
    if (Math.abs(t.x - b.sx) > 16 || Math.abs(t.z - b.sz) > 16) continue;
    const ex = t.x - x, ez = t.z - z, d = Math.hypot(ex, ez);
    // trunk clearance along the sight line
    const u = Math.min(0.93, Math.max(0, (ex * dx + ez * dz) / l2));
    const clear = Math.hypot(x + dx * u - t.x, z + dz * u - t.z) - t.trunkR;
    if (clear < 1.0) c += (1.0 - clear) * 6;
    if (d < t.trunkR + 1.6) c += (t.trunkR + 1.6 - d) * 8; // camera pressed against a trunk
    // foreground trunk inside the view cone: angular half-width vs. angular distance from the subject
    if (d < dist && d > 0.01) {
      const dAng = Math.abs(Math.atan2(Math.sin(Math.atan2(ex, ez) - yaw), Math.cos(Math.atan2(ex, ez) - yaw)));
      const half = Math.atan2(t.trunkR, d);
      const over = 0.42 + half - dAng; // 0.42 rad: keep the middle of the frame free (half-FOV ~0.6 rad)
      if (over > 0) c += over * (2 + half * 12);
    }
  }
  return c;
}

function buildTrack(world: World, frames: Frame[]): RigTrack {
  const end = frames[frames.length - 1].t;
  const N = Math.floor(end / NODE_DT) + 1, S = OFF_N * RADII.length;
  const cost: Float64Array[] = [];
  for (let n = 0; n < N; n++) {
    const b = rigBase(frames, n * NODE_DT), row = new Float64Array(S);
    for (let o = 0; o < OFF_N; o++) for (let r = 0; r < RADII.length; r++) row[o * RADII.length + r] = nodeCost(world, b, o, r);
    cost.push(row);
  }
  const R = RADII.length, MOVE = 0.3;
  const acc = new Float64Array(S), back: Int16Array[] = [];
  for (let s = 0; s < S; s++) acc[s] = cost[0][s];
  for (let n = 1; n < N; n++) {
    const nxt = new Float64Array(S), bp = new Int16Array(S);
    for (let o = 0; o < OFF_N; o++) for (let r = 0; r < R; r++) {
      let best = Infinity, arg = 0;
      for (let dO = -1; dO <= 1; dO++) for (let dR = -1; dR <= 1; dR++) {
        const po = (o + dO + OFF_N) % OFF_N, pr = r + dR;
        if (pr < 0 || pr >= R) continue;
        const v = acc[po * R + pr] + (dO !== 0 ? MOVE : 0) + (dR !== 0 ? 0.4 : 0);
        if (v < best - 1e-9) { best = v; arg = po * R + pr; }
      }
      nxt[o * R + r] = best + cost[n][o * R + r]; bp[o * R + r] = arg;
    }
    acc.set(nxt); back.push(bp);
  }
  let s = 0;
  for (let i = 1; i < S; i++) if (acc[i] < acc[s]) s = i;
  const off = new Float64Array(N), rad = new Float64Array(N), path = new Int16Array(N);
  path[N - 1] = s;
  for (let n = N - 1; n > 0; n--) path[n - 1] = back[n - 1][path[n]];
  let prevO = 0;
  for (let n = 0; n < N; n++) {
    let o = Math.floor(path[n] / R);
    if (n > 0) { while (o - prevO > OFF_N / 2) o -= OFF_N; while (prevO - o > OFF_N / 2) o += OFF_N; } // unwrap: never swing the long way
    prevO = o;
    off[n] = ((o - OFF_N / 2) * 2 * Math.PI) / OFF_N; rad[n] = RADII[path[n] % R];
  }
  // hat smoothing of the (already slew-limited) path
  const so = new Float64Array(N), sr = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let wo = 0, wn = 0, wr = 0;
    for (let k = -SMOOTH_NODES; k <= SMOOTH_NODES; k++) {
      const m = Math.min(N - 1, Math.max(0, n + k)), w = 1 - Math.abs(k) / (SMOOTH_NODES + 1);
      wo += off[m] * w; wr += rad[m] * w; wn += w;
    }
    so[n] = wo / wn; sr[n] = wr / wn;
  }
  return { off: so, rad: sr };
}

function trackFor(world: World, frames: Frame[]): RigTrack {
  let byWorld = trackCache.get(frames);
  if (!byWorld) trackCache.set(frames, (byWorld = new WeakMap()));
  let tr = byWorld.get(world);
  if (!tr) byWorld.set(world, (tr = buildTrack(world, frames)));
  return tr;
}

function catmull(a: Float64Array, i: number, u: number): number {
  const p0 = a[Math.max(0, i - 1)], p1 = a[i], p2 = a[i + 1], p3 = a[Math.min(a.length - 1, i + 2)];
  return p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)));
}

export function closeShotRig(world: World, frames: Frame[], t: number): CloseShot {
  const b = rigBase(frames, t);
  const tr = trackFor(world, frames);
  const g = Math.min(tr.off.length - 1 - 1e-9, Math.max(0, t / NODE_DT)), i = Math.floor(g), u = g - i;
  const off = catmull(tr.off, i, u), R = catmull(tr.rad, i, u); // C1 interpolation: no velocity steps at node boundaries
  const a = b.axis + off;
  const x = b.px + Math.sin(a) * R, z = b.pz + Math.cos(a) * R;
  const gy = world.heightAt(b.px, b.pz);
  const bias = 0.05; // slight look toward the drone keeps the runner centred
  const chestH = 0.95;
  // Aim halfway between the smoothed and the instantaneous subject: the camera body is calm, the subject never drifts out of frame.
  const lx = (b.px + b.sx) / 2, lz = (b.pz + b.sz) / 2;
  return {
    pos: { x, y: world.heightAt(x, z) + RIG_EYE, z },
    look: { x: lx + (b.dx - lx) * bias, y: gy + chestH + (b.dy - gy - chestH) * 0.04, z: lz + (b.dz - lz) * bias },
  };
}
