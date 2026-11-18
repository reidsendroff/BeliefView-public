import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeShot, closeShotFocus, closeShotRig } from "../src/render/spectator";
import { lineOfSight } from "../src/sim/geometry";
import { sampleAt } from "../src/sim/playback";
import { DEFAULT_CONFIG, buildWorld, simulate } from "../src/sim/simulate";

const world = buildWorld(DEFAULT_CONFIG);
const F = simulate(DEFAULT_CONFIG, world).frames;
const at = (t: number) => F[Math.round(t / DEFAULT_CONFIG.dt)];

describe("cinematic spectator framing (render-only)", () => {
  it("is deterministic in t (scrub = playback)", () => {
    for (const t of [0, 4.7, 13, 30, 60]) expect(closeShotFocus(F, t)).toEqual(closeShotFocus(F, t));
  });
  it("is close during sprint and hide beats and wide while walking", () => {
    const walk = F.find((f) => f.subject.action === "TRAVEL" && f.t < 2)!;
    expect(closeShotFocus(F, walk.t).w).toBeLessThan(0.3);
    const sprint = F.find((f) => f.subject.action === "SPRINT" && f.t > 3 && closeShotFocus(F, f.t).w > 0.9);
    expect(sprint).toBeDefined();
    const hide = F.find((f) => f.subject.action === "HIDE")!;
    const mid = F.filter((f) => f.subject.action === "HIDE")[Math.floor(F.filter((f) => f.subject.action === "HIDE").length / 2)];
    expect(hide).toBeDefined();
    expect(closeShotFocus(F, mid.t)).toMatchObject({ kind: "HIDE" });
    expect(closeShotFocus(F, mid.t).w).toBeGreaterThan(0.9);
  });
  it("transitions smoothly (no jumps between 50 ms steps)", () => {
    let prev = closeShotFocus(F, 0).w;
    for (let t = 0.05; t < F[F.length - 1].t; t += 0.05) {
      const w = closeShotFocus(F, t).w;
      expect(Math.abs(w - prev)).toBeLessThan(0.12);
      prev = w;
    }
  });
  it("places the close viewpoint a few metres from the subject and does not mutate frames", () => {
    const f = at(13);
    const snap = JSON.stringify(f);
    for (const kind of ["RUN", "HIDE"] as const) {
      const cs = closeShot(world, f, kind);
      const d = Math.hypot(cs.pos.x - f.subject.x, cs.pos.z - f.subject.z);
      expect(d).toBeGreaterThan(4.5);
      expect(d).toBeLessThan(9);
    }
    expect(JSON.stringify(f)).toBe(snap);
  });
});

describe("stable cinematic close-up rig (pure function of t)", () => {
  const end = F[F.length - 1].t;
  const yawPitch = (r: ReturnType<typeof closeShotRig>) => {
    const dx = r.look.x - r.pos.x, dy = r.look.y - r.pos.y, dz = r.look.z - r.pos.z;
    return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  };
  const dAng = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

  it("is continuous in position and view angle across the default timeline (jinks, turns, cover, transitions)", () => {
    const step = 1 / 60;
    let prev = closeShotRig(world, F, 0), pa = yawPitch(prev);
    let maxV = 0, maxYaw = 0, maxPitch = 0, maxDV = 0, pv = 0;
    for (let t = step; t <= end; t += step) {
      const r = closeShotRig(world, F, t), a = yawPitch(r);
      const v = Math.hypot(r.pos.x - prev.pos.x, r.pos.z - prev.pos.z) / step;
      maxV = Math.max(maxV, v);
      if (t > 2 * step) maxDV = Math.max(maxDV, Math.abs(v - pv));
      pv = v;
      maxYaw = Math.max(maxYaw, dAng(a.yaw, pa.yaw) / step);
      maxPitch = Math.max(maxPitch, Math.abs(a.pitch - pa.pitch) / step);
      prev = r; pa = a;
    }
    expect(maxV).toBeLessThan(14); // m/s: orbiting a ~6 m/s runner through turns, never a teleport
    expect(maxDV).toBeLessThan(0.5); // m/s change per 1/60 s step (~30 m/s^2): no velocity steps
    expect(maxYaw).toBeLessThan(1.3); // rad/s: a 6 m/s runner at ~5 m plus an obstruction-avoidance orbit (<= 0.52 rad/s) can pan ~1.2 rad/s; the point is no jumps
    expect(maxPitch).toBeLessThan(0.5);
  });
  it("keeps a steady distance and keeps the actual subject in view", () => {
    for (let t = 0; t <= end; t += 0.1) {
      const r = closeShotRig(world, F, t), sm = sampleAt(F, t), f = { x: sm.a.subject.x + (sm.b.subject.x - sm.a.subject.x) * sm.u, z: sm.a.subject.z + (sm.b.subject.z - sm.a.subject.z) * sm.u };
      const d = Math.hypot(r.pos.x - f.x, r.pos.z - f.z);
      expect(d).toBeGreaterThan(4.3); // radii 5.2-8 m from the smoothed subject; the runner moves ~1 m/node
      expect(d).toBeLessThan(9);
      const a = yawPitch(r);
      expect(dAng(a.yaw, Math.atan2(f.x - r.pos.x, f.z - r.pos.z))).toBeLessThan(0.5); // rad of yaw error (includes the deliberate small look-toward-drone bias), inside the horizontal half-FOV (~0.6 rad at 52 deg vertical, aspect 1.5)
    }
  });
  /** Largest fraction of the central view (|bearing from view axis| < 0.3 rad) blocked by a trunk nearer than the runner, as a half-width in rad (0 = none). */
  const foregroundTrunk = (t: number) => {
    const r = closeShotRig(world, F, t), s = sampleAt(F, t).a.subject;
    const dist = Math.hypot(s.x - r.pos.x, s.z - r.pos.z), yaw = yawPitch(r).yaw;
    let worst = 0;
    for (const tr of world.trees) {
      const ex = tr.x - r.pos.x, ez = tr.z - r.pos.z, d = Math.hypot(ex, ez);
      if (d >= dist || d < 0.01) continue;
      const half = Math.atan2(tr.trunkR, d), off = dAng(Math.atan2(ex, ez), yaw);
      if (off - half < 0.3) worst = Math.max(worst, half);
    }
    return worst;
  };
  const runnerClear = (t: number) => {
    const r = closeShotRig(world, F, t), s = sampleAt(F, t).a.subject, gy = world.heightAt(s.x, s.z);
    return lineOfSight(world, r.pos, { x: s.x, y: gy + 1, z: s.z }) === "NONE";
  };
  it("regression t=27 s (paused Cinematic): runner visible, no foreground trunk filling the central view", () => {
    expect(closeShotFocus(F, 27).w).toBeGreaterThan(0.5); // this is a close-up beat
    expect(runnerClear(27)).toBe(true);
    expect(foregroundTrunk(27)).toBeLessThan(0.1); // rad half-width: at most a thin distant-ish trunk, never a wall (the broken shot was a trunk spanning most of the view)
    for (let t = 26; t <= 28; t += 0.05) expect(runnerClear(t)).toBe(true);
    const r = closeShotRig(world, F, 27);
    for (const tr of world.trees) expect(Math.hypot(tr.x - r.pos.x, tr.z - r.pos.z)).toBeGreaterThan(tr.trunkR + 1.2); // not pressed against a trunk
  });
  it("keeps line of sight and a clear central view over the whole default timeline's close-up beats", () => {
    let n = 0, blocked = 0, run = 0, maxRun = 0, crowded = 0;
    for (let t = 0; t <= end; t += 0.05) {
      if (closeShotFocus(F, t).w < 0.5) { run = 0; continue; }
      n++;
      if (runnerClear(t)) run = 0; else { blocked++; run++; maxRun = Math.max(maxRun, run); }
      if (foregroundTrunk(t) > 0.15) crowded++;
    }
    expect(n).toBeGreaterThan(500);
    expect(blocked / n).toBeLessThan(0.05); // a runner passing behind a trunk can briefly be hidden; a continuous rig cannot teleport past it
    expect(maxRun * 0.05).toBeLessThan(0.6); // s: never occluded for long
    expect(crowded / n).toBeLessThan(0.05);
  });
  it("is deterministic under random access (same t, any order, no hidden state)", () => {
    const ts = Array.from({ length: 60 }, (_, i) => ((i * 37) % 600) / 10);
    const fwd = ts.map((t) => closeShotRig(world, F, t));
    const rev = [...ts].reverse().map((t) => closeShotRig(world, F, t)).reverse();
    expect(rev).toEqual(fwd);
  });
});

describe("camera label / disclaimer copy", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  it("keeps the synthetic disclaimer verbatim", () => {
    expect(html).toContain("<strong>SYNTHETIC ILLUSTRATIVE SIMULATION</strong>");
    expect(html).toContain("Procedural world, simulated drone and subject. Not a real drone or flight controller, not validated 3D performance, and unrelated to BeliefView v2 metrics (the frozen v2 experiment is 2D).");
  });
  it("labels the main view as evaluation-only spectator and the inset as the drone camera", () => {
    expect(html).toContain("evaluation-only spectator camera (not available to the drone)");
    expect(html).toContain("simulated drone camera");
  });
  it("keeps subject action text hidden by default", () => {
    expect(html).toContain('<dt id="subj-eval-dt" hidden');
    expect(html).toContain('<dd id="v-sact" hidden>');
  });
});
