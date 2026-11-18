import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeBelief, findPeaks, hpdRegion, type BeliefGrid } from "../../src/ml/belief";
import { GRID_N, cellOf, cellCentre, type FeatureOutput } from "../../src/ml/features";
import { LearnedSearchGuidance } from "../../src/ml/guidance";
import { replayFeatures } from "../../src/ml/replay";
import { DRONE, makeDrone } from "../../src/sim/drone";
import { lineOfSight, projectClear } from "../../src/sim/geometry";
import { DEFAULT_CONFIG, ML_STRIDE_STEPS, buildWorld, scenarioStartArea, simulate, simulateGuided } from "../../src/sim/simulate";
import { loadModel } from "./helpers";

const world = buildWorld(DEFAULT_CONFIG);

function twoPeak(): BeliefGrid {
  const center = { x: 0, z: 0 };
  const prob = new Float32Array(GRID_N * GRID_N);
  const put = (x: number, z: number, m: number) => { const c = cellOf(center, x, z)!; prob[c.i * GRID_N + c.j] += m; };
  put(-20, -10, 0.45); put(18, 12, 0.35); put(0, 0, 0.2);
  return { i: 0, t: 10, center, prob, elapsed: 10 };
}

describe("probability grid helpers", () => {
  it("finds several peaks with their mass and a 95% region that covers >= 95% of the mass", () => {
    const b = twoPeak();
    const pk = findPeaks(b, 3, 1, 0.05);
    expect(pk.length).toBe(3);
    expect(pk[0].mass).toBeCloseTo(0.45, 5);
    expect(hpdRegion(b, 0.95).mass).toBeGreaterThanOrEqual(0.95);
    expect(hpdRegion(b, 0.95).cells).toBe(3);
  });
});

describe("learned viewpoint scoring", () => {
  const start = scenarioStartArea(DEFAULT_CONFIG);
  const drone = makeDrone(world, { x: start.x, z: start.z }, start);

  it("scores viewpoints by weighted visible probability mass with map line of sight, deterministically", () => {
    const g = new LearnedSearchGuidance();
    const b = twoPeak();
    g.setBelief(b);
    const r1 = g.score(world, drone), r2 = g.score(world, drone);
    expect(r1).not.toBeNull();
    expect(r2).toEqual(r1);
    expect(r1!.mass).toBeGreaterThan(0.1);
    // the claimed mass is real: re-derive it from line of sight
    const p = { x: r1!.x, y: world.heightAt(r1!.x, r1!.z) + DRONE.searchAgl, z: r1!.z };
    let visible = 0;
    for (let k = 0; k < b.prob.length; k++) {
      if (b.prob[k] === 0) continue;
      const c = cellCentre(b.center, Math.floor(k / GRID_N), k % GRID_N);
      const tp = { x: c.x, y: world.heightAt(c.x, c.z) + 1.3, z: c.z };
      if (Math.hypot(tp.x - p.x, tp.y - p.y, tp.z - p.z) <= 38 && lineOfSight(world, p, tp) === "NONE") visible += b.prob[k];
    }
    expect(visible).toBeGreaterThanOrEqual(r1!.mass - 1e-6);
    const q = { ...p };
    expect(projectClear(world, q, DRONE.obstacleMargin, DRONE.minAgl) && Math.hypot(q.x - p.x, q.z - p.z) > 0.01).toBe(false);
  });

  it("falls back (returns null) without a belief, and the gaze only exists with one", () => {
    const g = new LearnedSearchGuidance();
    expect(g.chooseViewpoint(world, drone)).toBeNull();
    expect(g.gazeTarget()).toBeNull();
    g.setBelief(twoPeak());
    expect(g.chooseViewpoint(world, drone)).not.toBeNull();
    expect(g.gazeTarget()).not.toBeNull();
    g.setBelief(null);
    expect(g.gazeTarget()).toBeNull();
  });

  it("moving the probability mass moves the chosen viewpoint (it is not a fixed pattern)", () => {
    const a = new LearnedSearchGuidance(), c = new LearnedSearchGuidance();
    const b1 = twoPeak();
    const b2: BeliefGrid = { ...b1, center: { x: 30, z: 40 } };
    a.setBelief(b1); c.setBelief(b2);
    const ra = a.score(world, drone)!, rc = c.score(world, drone)!;
    expect(Math.hypot(ra.x - rc.x, ra.z - rc.z)).toBeGreaterThan(10);
  });
});

describe("closed-loop learned run (real ONNX model)", () => {
  it("is deterministic for a fixed model and seed, independent of inference timing, and predicts only at fixed steps", async () => {
    const model = await loadModel();
    const calls: number[] = [];
    const run = async (jitter: boolean) => {
      const rec: number[] = [];
      const tl = await simulateGuided(DEFAULT_CONFIG, world, async (f: FeatureOutput) => {
        if (jitter) await new Promise((r) => setTimeout(r, Math.random() * 3));
        rec.push(Math.round(f.t / DEFAULT_CONFIG.dt));
        return model.predict(f);
      }, { stride: ML_STRIDE_STEPS });
      return { tl, rec };
    };
    const a = await run(false), b = await run(true);
    calls.push(...a.rec);
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((i) => i % ML_STRIDE_STEPS === 0)).toBe(true);
    expect(JSON.stringify(b.tl.frames)).toBe(JSON.stringify(a.tl.frames));
    expect(b.tl.ml!.beliefs.map((x) => x && Array.from(x.prob))).toEqual(a.tl.ml!.beliefs.map((x) => x && Array.from(x.prob)));
  }, 120000);

  it("uses the learned scorer for search viewpoints, keeps physical limits, and the model-path features equal the replayed features", async () => {
    const model = await loadModel();
    const seen = new Map<number, FeatureOutput>();
    const tl = await simulateGuided(DEFAULT_CONFIG, world, (f) => model.predict(f), { stride: ML_STRIDE_STEPS, onFeatures: (i, f) => seen.set(i, f) });
    expect(tl.ml!.guidance.learnedChoices).toBeGreaterThan(0);
    expect(tl.ml!.beliefs.filter(Boolean).length).toBeGreaterThan(5);
    expect(tl.frames.some((f) => f.mode === "SEARCH")).toBe(true);
    for (const f of tl.frames) {
      expect(f.drone.agl).toBeGreaterThanOrEqual(DRONE.minAgl - 0.06);
      expect(Math.hypot(f.drone.vx, f.drone.vz)).toBeLessThanOrEqual(DRONE.maxHSpeed + 1.5);
      expect(Math.abs(f.drone.vy)).toBeLessThanOrEqual(DRONE.maxVSpeed + 1.5);
    }
    let replayed = 0;
    replayFeatures(tl.frames, world, ML_STRIDE_STEPS, (i, f) => {
      const live = seen.get(i)!;
      expect(Buffer.from(live.codes).equals(Buffer.from(f.codes))).toBe(true);
      expect(Array.from(live.scalars)).toEqual(Array.from(f.scalars));
      replayed++;
    });
    expect(replayed).toBe(seen.size);
  }, 120000);

  it("makeBelief copies the probabilities (later mutation of the model output cannot change playback)", () => {
    const f = { center: { x: 1, z: 2 }, t: 3, elapsed: 2 } as FeatureOutput;
    const p = new Float32Array(GRID_N * GRID_N).fill(1 / (GRID_N * GRID_N));
    const b = makeBelief(60, f, p);
    p[0] = 99;
    expect(b.prob[0]).not.toBe(99);
  });
});

describe("Kalman default is unchanged by the learned-guidance work", () => {
  it("default and alternate-seed Kalman frames hash to the pre-change golden digests", () => {
    const h = (o: object) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
    expect(h(simulate().frames)).toBe("dc8e8e3f71943800de64e6d86121dd5c7f1300c039c6d79cc6e49cc980765f7a");
    expect(h(simulate({ ...DEFAULT_CONFIG, seed: 123, subjectSeed: 7 }).frames)).toBe("90fe4b8f329e52eb8a6328fa341995b0fc09f0bad234bb786d75a318ee207ee0");
    expect("ml" in simulate()).toBe(false);
  });
});
