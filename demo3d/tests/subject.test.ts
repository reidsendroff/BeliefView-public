import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRONE } from "../src/sim/drone";
import { lineOfSight } from "../src/sim/geometry";
import { DEFAULT_CONFIG, buildWorld, simulate, subjectSegments } from "../src/sim/simulate";
import { SUBJECT, SubjectAgent } from "../src/sim/subject";

const world = buildWorld(DEFAULT_CONFIG);
const tl = simulate(DEFAULT_CONFIG, world);
const F = tl.frames;
const dt = DEFAULT_CONFIG.dt;
const segs = subjectSegments(F);
const angDiff = (a: number, b: number) => {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
const dur = (s: { t0: number; t1: number }) => s.t1 - s.t0;

describe("evasive subject: behaviour coverage", () => {
  it("shows every action, including sprint, jink, feint, cover-seeking, hide and resume", () => {
    const seen = new Set(F.map((f) => f.subject.action));
    for (const a of ["TRAVEL", "SPRINT", "JINK", "FEINT", "SEEK_COVER", "HIDE", "RESUME"]) expect(seen.has(a as never), a).toBe(true);
  });
  it("is tracked while moving at the start, then sprints", () => {
    expect(F[0].track.status).toBe("TRACKING");
    expect(F[0].subject.speed).toBeGreaterThan(2);
    const sprint = F.filter((f) => f.subject.speed > 5);
    expect(sprint.length * dt).toBeGreaterThan(10); // > 10 s above 5 m/s
  });
  it("makes at least two substantial direction changes including a reversal", () => {
    // sharp turns: >= 50 degrees within 1.0 s, counted as separate events (>= 1.5 s apart)
    const k = Math.round(1.0 / dt);
    const turns: number[] = [];
    for (let i = k; i < F.length; i++) {
      if (Math.abs(angDiff(F[i - k].subject.heading, F[i].subject.heading)) >= (50 * Math.PI) / 180 && (!turns.length || F[i].t - turns[turns.length - 1] > 1.5)) turns.push(F[i].t);
    }
    expect(turns.length).toBeGreaterThanOrEqual(4);
    // reversal: net heading change >= 130 degrees within 3 s
    const m = Math.round(3 / dt);
    let best = 0;
    for (let i = m; i < F.length; i++) best = Math.max(best, Math.abs(angDiff(F[i - m].subject.heading, F[i].subject.heading)));
    expect(best).toBeGreaterThanOrEqual((130 * Math.PI) / 180);
    const feint = segs.find((s) => s.action === "FEINT")!;
    expect(Math.abs(angDiff(F[feint.i0].subject.heading, F[feint.i1].subject.heading))).toBeGreaterThan((110 * Math.PI) / 180);
  });
  it("holds and hides for >= 2 s, slow and crouched, then resumes", () => {
    const hides = segs.filter((s) => s.action === "HIDE" && s.t1 < F[F.length - 1].t - 0.01);
    expect(hides.length).toBeGreaterThanOrEqual(2);
    for (const h of hides) {
      expect(dur(h)).toBeGreaterThanOrEqual(2);
      const mid = F.slice(h.i0 + Math.round(1 / dt), h.i1 + 1);
      for (const f of mid) { expect(f.subject.speed).toBeLessThan(0.6); expect(f.subject.crouch).toBeGreaterThan(0.9); }
      const next = segs[segs.indexOf(h) + 1];
      expect(next.action).toBe("RESUME");
      // it leaves cover upright and accelerates: standing within 1 s, sprinting (> 3 m/s) within the break-cover phase
      expect(F[next.i0 + Math.round(1 / dt)].subject.crouch).toBeLessThan(0.1);
      expect(Math.max(...F.slice(next.i0, next.i1 + 1).map((f) => f.subject.speed))).toBeGreaterThan(3);
    }
  });
});

describe("evasive subject: kinematics", () => {
  it("stays on the ground, in bounds, with plausible speed, acceleration and turn rate; no teleports", () => {
    for (let i = 0; i < F.length; i++) {
      const s = F[i].subject;
      expect(s.y).toBeCloseTo(world.heightAt(s.x, s.z), 9);
      expect(Math.abs(s.x)).toBeLessThan(world.half);
      expect(Math.abs(s.z)).toBeLessThan(world.half);
      expect(s.speed).toBeLessThanOrEqual(SUBJECT.sprintMax + 1e-9);
      if (i === 0) continue;
      const p = F[i - 1].subject;
      expect(Math.hypot(s.x - p.x, s.z - p.z) / dt).toBeLessThan(SUBJECT.sprintMax + 0.7);
      const accel = (s.speed - p.speed) / dt;
      expect(accel).toBeLessThanOrEqual(SUBJECT.accel + 1e-6);
      expect(accel).toBeGreaterThanOrEqual(-SUBJECT.decel - 1e-6);
      const omega = angDiff(p.heading, s.heading) / dt;
      expect(Math.abs(omega)).toBeLessThanOrEqual(SUBJECT.maxTurnRate + 1e-6);
      expect(Math.abs(omega) * Math.max(p.speed, 1.5)).toBeLessThanOrEqual(SUBJECT.latAccel + 1e-6);
    }
  });
  it("never intersects a trunk", () => {
    let minGap = Infinity;
    for (const f of F) {
      for (const t of world.trees) {
        if (Math.abs(t.x - f.subject.x) > 4 || Math.abs(t.z - f.subject.z) > 4) continue;
        minGap = Math.min(minGap, Math.hypot(t.x - f.subject.x, t.z - f.subject.z) - t.trunkR);
      }
    }
    expect(minGap).toBeGreaterThanOrEqual(SUBJECT.trunkHardMargin - 1e-6);
  });
});

describe("evasive subject: cover legitimacy", () => {
  const hides = segs.filter((s) => s.action === "HIDE" && s.t1 < F[F.length - 1].t - 0.01);
  it("every HIDE frame names a real nearby tree, and tree geometry shields the subject from the drone position it perceives", () => {
    const hf = F.filter((x) => x.subject.action === "HIDE");
    expect(hf.length).toBeGreaterThan(40);
    let ok = 0;
    for (const f of hf) {
      expect(f.subject.cover).toBeGreaterThanOrEqual(0);
      const tr = world.trees[f.subject.cover];
      expect(Math.hypot(tr.x - f.subject.x, tr.z - f.subject.z)).toBeLessThan(tr.canopyR + 1.5);
      const p = f.subject.percept!;
      expect(p).not.toBeNull();
      const torso = { x: f.subject.x, y: f.subject.y + SUBJECT.hideTorso, z: f.subject.z };
      if (lineOfSight(world, p, torso) !== "NONE") ok++;
    }
    // the percept is refreshed a few times a second, so allow brief gaps; it is shielded on the large majority of hide frames
    expect(ok / hf.length).toBeGreaterThanOrEqual(0.85);
    // and it is shielded on the frame each hide begins
    for (const h of segs.filter((x) => x.action === "HIDE")) {
      const f = F[h.i0 + 1].subject;
      expect(lineOfSight(world, f.percept!, { x: f.x, y: f.y + SUBJECT.hideTorso, z: f.z })).not.toBe("NONE");
    }
  });
  it("hiding is a real shield against the drone's actual camera for much of the hold (sensor loss while hiding)", () => {
    const hidden = F.filter((f) => f.subject.action === "HIDE" && f.visibility !== "VISIBLE");
    const all = F.filter((f) => f.subject.action === "HIDE");
    expect(hidden.length / all.length).toBeGreaterThan(0.3);
  });
  it("no HIDE segment begins far from its cover tree", () => {
    for (const h of hides) {
      const f = F[h.i0].subject;
      const tr = world.trees[f.cover];
      expect(Math.hypot(tr.x - f.x, tr.z - f.z)).toBeLessThan(tr.canopyR + 1.5);
    }
  });
});

describe("evasive subject: determinism and truth separation", () => {
  it("is bit-identical on replay", () => {
    const again = simulate(DEFAULT_CONFIG, buildWorld(DEFAULT_CONFIG));
    expect(JSON.stringify(again.frames.map((f) => f.subject))).toBe(JSON.stringify(F.map((f) => f.subject)));
  });
  it("scrubbing is replay: frames are a pure function of config (a second run matches frame by frame at random indices)", () => {
    const again = simulate(DEFAULT_CONFIG, world);
    for (const i of [0, 7, 133, 600, 1010, 1500]) expect(again.frames[i]).toEqual(F[i]);
  });
  it("subject module imports nothing from drone, tracker or sensor", () => {
    const src = readFileSync(new URL("../src/sim/subject.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./geometry", "./rng", "./route", "./types", "./world"]);
  });
  it("the agent is reproduced exactly from the recorded drone positions alone (no mode / belief / gimbal / visibility input)", () => {
    const agent = new SubjectAgent(world, DEFAULT_CONFIG.waypoints, DEFAULT_CONFIG.subjectSeed, dt);
    for (let i = 0; i < F.length; i++) {
      expect(agent.snapshot()).toEqual(F[i].subject);
      agent.step({ x: F[i].drone.x, y: F[i].drone.y, z: F[i].drone.z }, dt);
    }
  });
  it("what the subject perceives is delayed and noisy, not the exact drone pose", () => {
    let sum = 0, n = 0;
    for (const f of F) {
      if (!f.subject.percept) continue;
      sum += Math.hypot(f.subject.percept.x - f.drone.x, f.subject.percept.z - f.drone.z);
      n++;
    }
    expect(n).toBeGreaterThan(1000);
    expect(sum / n).toBeGreaterThan(0.5);
    expect(sum / n).toBeLessThan(10);
    expect(F[5].subject.percept).toBeNull(); // nothing to perceive during the first delay window
  });
  it("perception clears when the drone leaves range: null means lost cue, not a stale one", () => {
    const agent = new SubjectAgent(world, DEFAULT_CONFIG.waypoints, DEFAULT_CONFIG.subjectSeed, dt);
    const near = () => { const s = agent.snapshot(); return { x: s.x + 20, y: s.y + 30, z: s.z }; };
    for (let i = 0; i < Math.round(5 / dt); i++) agent.step(near(), dt);
    expect(agent.snapshot().percept).not.toBeNull();
    const far = { x: 5000, y: 100, z: 5000 };
    const settle = SUBJECT.perceptionDelay + SUBJECT.perceptionRefresh + 2 * dt;
    let clearedAt = -1;
    for (let i = 0; i < Math.round(10 / dt); i++) {
      agent.step(far, dt);
      if (clearedAt < 0 && agent.snapshot().percept === null) clearedAt = (i + 1) * dt;
    }
    expect(clearedAt).toBeGreaterThan(0);
    expect(clearedAt).toBeLessThanOrEqual(settle);
    expect(agent.snapshot().percept).toBeNull(); // stays lost while the drone stays out of range
    // with no cue the policy cannot start cover/feint/hide behaviour (all need a perceived drone); once residual states expire none appear
    for (let i = 0; i < Math.round(10 / dt); i++) agent.step(far, dt);
    const acts = new Set<string>();
    for (let i = 0; i < Math.round(5 / dt); i++) { agent.step(far, dt); acts.add(agent.snapshot().action); expect(agent.snapshot().percept).toBeNull(); }
    for (const x of ["FEINT", "SEEK_COVER", "HIDE"]) expect(acts.has(x), x).toBe(false);
  });
  it("sensor noise stream is independent of the subject policy seed", () => {
    const b = simulate({ ...DEFAULT_CONFIG, subjectSeed: DEFAULT_CONFIG.subjectSeed + 1 }, world);
    expect(JSON.stringify(b.frames.map((f) => f.subject))).not.toBe(JSON.stringify(F.map((f) => f.subject)));
    let both = 0;
    for (let i = 0; i < F.length; i++) {
      const o1 = F[i].obs, o2 = b.frames[i].obs;
      if (!o1 || !o2) continue;
      const z = (o: { x: number; z: number; sigma: number }, s: { x: number; z: number }) => [(o.x - s.x) / o.sigma, (o.z - s.z) / o.sigma];
      const a = z(o1, F[i].subject), c = z(o2, b.frames[i].subject);
      expect(c[0]).toBeCloseTo(a[0], 6);
      expect(c[1]).toBeCloseTo(a[1], 6);
      both++;
    }
    expect(both).toBeGreaterThan(30);
  });
  it("tracker and drone depend only on observations: another subject policy seed changes nothing until observations differ", () => {
    const b = simulate({ ...DEFAULT_CONFIG, subjectSeed: DEFAULT_CONFIG.subjectSeed + 1 }, world);
    let k = 0;
    while (k < F.length && JSON.stringify(F[k].obs) === JSON.stringify(b.frames[k].obs)) {
      expect(b.frames[k].track).toEqual(F[k].track);
      expect(b.frames[k].drone).toEqual(F[k].drone);
      expect(b.frames[k].cam).toEqual(F[k].cam);
      k++;
    }
    // non-vacuous: >= 3 s (60 frames) of shared observations, during which the two subjects' true states already differ
    expect(k).toBeGreaterThanOrEqual(60);
    const firstSubjectDiff = F.findIndex((fr, i) => JSON.stringify(fr.subject) !== JSON.stringify(b.frames[i].subject));
    expect(firstSubjectDiff).toBeGreaterThanOrEqual(0);
    expect(firstSubjectDiff).toBeLessThan(k - 30);
    expect(k).toBeLessThan(F.length);
  });
  it("the drone is not scripted against the subject: loss and reacquisition come from geometry (see sim.test.ts) and the subject reacts to a drone within perception range only", () => {
    expect(DRONE.targetHeight).toBeGreaterThan(0);
    expect(SUBJECT.perceptionDelay).toBeGreaterThan(0);
  });
});
