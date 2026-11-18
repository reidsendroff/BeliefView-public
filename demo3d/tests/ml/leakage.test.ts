import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { episodeConfig, splitSeeds } from "../../src/ml/episodes";
import { SCALARS, FeatureExtractor, type FeatureOutput, type FeatureStep } from "../../src/ml/features";
import { replayFeatures, toFeatureStep, type NarrowFrame } from "../../src/ml/replay";
import { Rng } from "../../src/sim/rng";
import { DEFAULT_CONFIG, buildWorld, scenarioStartArea, simulate, simulateGuided, COARSE_AREA_M } from "../../src/sim/simulate";
import type { Frame } from "../../src/sim/types";

const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const importsOf = (s: string) => [...s.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();

describe("inference trust boundary (static)", () => {
  it("feature extractor imports only the known-map, geometry and sensor-model modules", () => {
    expect(importsOf(src("ml/features.ts"))).toEqual(["../sim/geometry", "../sim/sensor", "../sim/world"]);
  });
  it("no model-path module imports truth/eval code (subject, scenarios, tracker, closed-loop metrics)", () => {
    for (const f of ["features", "belief", "guidance", "model", "manifest", "boot", "replay", "sha256", "ortWeb"]) {
      for (const imp of importsOf(src(`ml/${f}.ts`))) {
        expect(imp, `${f}.ts imports ${imp}`).not.toMatch(/subject|scenarios|tracker|closedLoop|episodes/);
      }
    }
    // everything under src/ml except the explicitly evaluation-only modules is truth-free
    const evalOnly = new Set(["scenarios.ts", "closedLoop.ts", "episodes.ts"]);
    for (const f of readdirSync(new URL("../../src/ml/", import.meta.url)).filter((x) => x.endsWith(".ts") && !x.endsWith(".d.ts") && !evalOnly.has(x))) {
      const s = code(src(`ml/${f}`));
      expect(s, f).not.toMatch(/\.subject\b|visibility|\.cover\b|\.percept\b|SubjectAgent/);
    }
  });
  it("the coarse set-up branch never reads subject state; the learned path always uses it", () => {
    const s = src("sim/simulate.ts");
    const i0 = s.indexOf('if (start === "coarse") {');
    const block = code(s.slice(i0, s.indexOf("} else {", i0)));
    expect(block).toContain("scenarioStartArea(config)");
    expect(block).not.toMatch(/snapshot\(|s0\b|subject|agent/);
    const fn = code(s.slice(s.indexOf("export function scenarioStartArea"), s.indexOf("export function buildWorld")));
    expect(fn).not.toMatch(/snapshot\(|SubjectAgent|agent|subject/);
    expect(code(s)).toContain('simulateCore(config, world, "coarse", opts)');
  });
  it("the feature extractor takes no start position of any kind and refuses to run before the first noisy fix", () => {
    const f = code(src("ml/features.ts"));
    expect(f).not.toMatch(/hint|StartHint|startArea|scenarioStart/i);
    expect(SCALARS.join()).not.toMatch(/hint|start/);
    const ex = new FeatureExtractor(buildWorld(DEFAULT_CONFIG));
    const f0 = toFeatureStep(simulate(DEFAULT_CONFIG, buildWorld(DEFAULT_CONFIG), "coarse").frames[0]);
    ex.push({ ...f0, obs: null });
    expect(ex.lost()).toBe(false);
    expect(() => ex.extract()).toThrow(/before the first noisy fix/);
    for (let k = 0; k < 40; k++) { ex.push({ ...f0, t: 0.05 * (k + 1), obs: null }); expect(ex.lost()).toBe(false); }
  });
  it("the designated start area is coarse (never the exact start) on the default and on varied episodes", () => {
    for (const [cfg] of [[DEFAULT_CONFIG], ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => { const s = splitSeeds("audit", k); return [episodeConfig(s.worldSeed, s.subjectSeed)]; })]) {
      const exact = simulate(cfg, buildWorld(cfg)).frames[0].subject;
      const a = scenarioStartArea(cfg);
      const d = Math.hypot(a.x - exact.x, a.z - exact.z);
      expect(d, "area must not equal the exact start").toBeGreaterThan(0.05);
      expect(Math.abs(a.x - exact.x)).toBeLessThanOrEqual(COARSE_AREA_M / 2 + 1e-9);
      expect(Math.abs(a.z - exact.z)).toBeLessThanOrEqual(COARSE_AREA_M / 2 + 1e-9);
      expect(a.x % COARSE_AREA_M).not.toBe(0); // cell centres, not grid lines
    }
  });
  it("learned-guidance run: the model is never called before the first fix and is called only for fixed-step lost ticks", async () => {
    const calls: number[] = [];
    const tl = await simulateGuided(DEFAULT_CONFIG, buildWorld(DEFAULT_CONFIG), async (f) => { calls.push(f.t); return new Float32Array(1024).fill(1 / 1024); });
    const firstFix = tl.frames.find((fr) => fr.obs)!.t;
    expect(calls.length).toBeGreaterThan(0);
    expect(Math.min(...calls)).toBeGreaterThan(firstFix);
    expect(tl.ml!.startArea).toEqual(scenarioStartArea(DEFAULT_CONFIG));
  }, 60000);
  it("the narrow step type has no room for truth (compile-time check via ts-expect-error)", () => {
    // @ts-expect-error `subject` is not part of FeatureStep
    const bad: FeatureStep = { t: 0, obs: null, drone: { x: 0, y: 0, z: 0, camYaw: 0, camPitch: 0 }, subject: { x: 1, z: 2 } };
    void bad;
    // @ts-expect-error visibility verdicts are not part of FeatureStep
    const bad2: FeatureStep = { t: 0, obs: null, drone: { x: 0, y: 0, z: 0, camYaw: 0, camPitch: 0 }, visibility: "VISIBLE" };
    void bad2;
    expect(true).toBe(true);
  });
});

function digest(out: FeatureOutput[]): string[] {
  return out.map((o) => `${o.t}|${o.center.x},${o.center.z}|${Buffer.from(o.codes).toString("base64")}|${Array.from(o.scalars).join(",")}`);
}
function features(frames: readonly NarrowFrame[], world: ReturnType<typeof buildWorld>): FeatureOutput[] {
  const out: FeatureOutput[] = [];
  replayFeatures(frames, world, 20, (_i, f) => out.push(f));
  return out;
}

describe("adversarial truth/visibility perturbation", () => {
  const cfg = episodeConfig(40001, 45001);
  const world = buildWorld(cfg);
  const tl = simulate(cfg, world, "coarse");
  const base = features(tl.frames, world);

  it("produces a non-trivial set of lost-run features", () => {
    expect(base.length).toBeGreaterThanOrEqual(8);
    expect(new Set(digest(base)).size).toBe(base.length);
  });

  it("is identical when subject truth, action, cover, percept, visibility, tracker and mode are scrambled", () => {
    const rng = new Rng(99);
    const actions = ["TRAVEL", "SPRINT", "JINK", "FEINT", "SEEK_COVER", "HIDE", "RESUME"] as const;
    const reasons = ["VISIBLE", "OCCLUDED_CANOPY", "OCCLUDED_TRUNK", "OCCLUDED_TERRAIN", "OUT_OF_RANGE", "OUT_OF_FOV"] as const;
    const scrambled: Frame[] = tl.frames.map((f) => ({
      ...f,
      subject: { ...f.subject, x: rng.range(-90, 90), z: rng.range(-90, 90), action: actions[Math.floor(rng.next() * 7)], cover: Math.floor(rng.next() * 800) - 1, crouch: rng.next(), speed: rng.range(0, 9), percept: { x: rng.next(), y: 0, z: rng.next() } },
      visibility: reasons[Math.floor(rng.next() * 6)],
      track: { ...f.track, x: rng.range(-50, 50), z: rng.range(-50, 50), radius: rng.range(0, 40), status: "TRACKING" },
      mode: "FOLLOW_HIGH", viewpoint: { x: rng.next(), z: rng.next() },
    }));
    expect(digest(features(scrambled, world))).toEqual(digest(base));
  });

  it("never touches forbidden fields: frames wrapped in throwing proxies still replay", () => {
    const forbidden = new Set(["subject", "visibility", "track", "mode", "viewpoint"]);
    const guarded = tl.frames.map((f) => new Proxy(f, { get(t, k, r) { if (typeof k === "string" && forbidden.has(k)) throw new Error(`forbidden field read: ${k}`); return Reflect.get(t, k, r); } }));
    expect(digest(features(guarded as unknown as NarrowFrame[], world))).toEqual(digest(base));
  });

  it("extra properties on a step are ignored by the extractor itself", () => {
    const ex = new FeatureExtractor(world);
    const step = { ...toFeatureStep(tl.frames[0]), subject: { x: 5 }, truthPosition: { x: 5, z: 5 } } as unknown as FeatureStep;
    const evil = new Proxy(step, { get(t, k, r) { if (k === "subject" || k === "truthPosition") throw new Error("read forbidden"); return Reflect.get(t, k, r); } });
    expect(() => ex.push(evil)).not.toThrow();
  });

  it("is not vacuous: changing the observations changes the features", () => {
    const moved = tl.frames.map((f) => (f.obs ? { ...f, obs: { ...f.obs, x: f.obs.x + 7 } } : f));
    expect(digest(features(moved, world))).not.toEqual(digest(base));
  });
});
