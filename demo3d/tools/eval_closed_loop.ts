/**
 * Closed-loop comparison on identical held-out (world seed, subject seed, start jitter) scenarios: Kalman guidance vs
 * learned guidance, both through the real simulator. PRIMARY baseline = Kalman with the SAME coarse start set-up as the learned run
 * (no exact start for either); the original exact-start Kalman demo run is reported alongside as a reference. The learned run executes the exported ONNX file via onnxruntime
 * (Node build of onnxruntime-web). NOTE: the subject reacts to the drone, so the two runs' subject paths can diverge.
 *
 *   npx tsx tools/eval_closed_loop.ts --model public/models/beliefview3d-search-v1 --count 100 --split test|audit --out ml/results/closed_loop.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as ort from "onnxruntime-web";
import { paired, percentile, runOutcome, subjectDivergence, type RunOutcome } from "../src/ml/closedLoop";
import { episodeConfig, splitSeeds } from "../src/ml/episodes";
import { LearnedModel } from "../src/ml/model";
import { buildWorld, ML_STRIDE_STEPS, simulate, simulateGuided } from "../src/sim/simulate";

function arg(name: string, def?: string): string {
  const k = process.argv.indexOf(`--${name}`);
  if (k >= 0 && process.argv[k + 1]) return process.argv[k + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}
const modelDir = resolve(arg("model"));
const count = Number(arg("count", "100"));
const out = arg("out");
const split = arg("split", "test") as "test" | "val" | "audit";

const fetchBytes = async (u: string) => new Uint8Array(readFileSync(u));
const model = await LearnedModel.load({ manifestUrl: `${modelDir}/manifest.json`, ort, fetchBytes });

interface Ep { id: string; worldSeed: number; subjectSeed: number; kalman: RunOutcome; kalmanExactStart: RunOutcome; ml: RunOutcome; divergenceRmsM: number; groups: string[]; mlSimSeconds: number; learnedChoices: number; fallbackChoices: number; beliefTicks: number }
const eps: Ep[] = [];
const t0 = performance.now();
for (let k = 0; k < count; k++) {
  const { worldSeed, subjectSeed } = splitSeeds(split, k);
  const cfg = episodeConfig(worldSeed, subjectSeed);
  const world = buildWorld(cfg);
  const kt = simulate(cfg, world, "coarse");
  const kx = simulate(cfg, world, "exact");
  const s0 = performance.now();
  const mt = await simulateGuided(cfg, world, (f) => model.predict(f), { stride: ML_STRIDE_STEPS });
  const mlSec = (performance.now() - s0) / 1000;
  const ko = runOutcome(kt.frames), mo = runOutcome(mt.frames);
  const groups: string[] = [];
  if (ko.runs.some((r) => r.hid)) groups.push("hide");
  if (ko.runs.some((r) => r.turned)) groups.push("turn");
  if (ko.runs.some((r) => r.long)) groups.push("long");
  if (ko.runs.some((r) => r.reacquired)) groups.push("reacq");
  eps.push({ id: `${split}-${k}`, worldSeed, subjectSeed, kalman: ko, kalmanExactStart: runOutcome(kx.frames), ml: mo, divergenceRmsM: subjectDivergence(kt.frames, mt.frames), groups, mlSimSeconds: mlSec,
    learnedChoices: mt.ml!.guidance.learnedChoices, fallbackChoices: mt.ml!.guidance.fallbacks, beliefTicks: mt.ml!.beliefs.filter(Boolean).length });
  if ((k + 1) % 10 === 0) console.error(`${k + 1}/${count} episodes, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}

type Base = "kalman" | "kalmanExactStart";
function summarise(sel: Ep[], base: Base = "kalman") {
  const withLoss = sel.filter((e) => e[base].firstLossTimeS !== null && e.ml.firstLossTimeS !== null);
  return {
    episodes: sel.length,
    bothRunsHaveALoss: withLoss.length,
    firstLossSearchTimeS: paired(withLoss.map((e) => e[base].firstLossTimeS!), withLoss.map((e) => e.ml.firstLossTimeS!)),
    unobservedTotalS: paired(sel.map((e) => e[base].unobservedS), sel.map((e) => e.ml.unobservedS)),
    firstLossReacquired: { kalman: withLoss.filter((e) => e[base].firstLossReacquired).length, ml: withLoss.filter((e) => e.ml.firstLossReacquired).length, of: withLoss.length },
  };
}
const groupNames = ["hide", "turn", "long", "reacq"];
const worse = eps
  .map((e) => ({ id: e.id, worldSeed: e.worldSeed, subjectSeed: e.subjectSeed, groups: e.groups,
    firstLossKalmanS: e.kalman.firstLossTimeS, firstLossMlS: e.ml.firstLossTimeS, unobservedKalmanS: e.kalman.unobservedS, unobservedMlS: e.ml.unobservedS,
    unobservedDiffS: e.ml.unobservedS - e.kalman.unobservedS, divergenceRmsM: e.divergenceRmsM }))
  .filter((e) => e.unobservedDiffS > 2).sort((a, b) => b.unobservedDiffS - a.unobservedDiffS);
const lat = model.stats.samplesMs;
const report = {
  config: { split, evaluationRole: split === "audit" ? "FINAL AUDIT (fresh split, frozen model)" : "DEVELOPMENT", episodes: count, stride_s: ML_STRIDE_STEPS * 0.05, model: model.manifest.modelId, modelSha256: model.info.sha256, runtime: `onnxruntime-web ${ort.env.versions?.common ?? ""} (Node, wasm EP, 1 thread)` },
  note: "Subject reacts to the drone, so subject paths differ between the two runs (see divergence). Differences are paired by scenario seed but are not controlled counterfactuals.",
  baselineNote: "Primary baseline = Kalman guidance with the same coarse start set-up as the learned run. 'vsKalmanExactStart' is an evaluation-only legacy reference that starts at the subject's exact position (an information advantage neither browser guidance mode receives).",
  overall: summarise(eps),
  vsKalmanExactStart: summarise(eps, "kalmanExactStart"),
  byScenarioGroup: Object.fromEntries(groupNames.map((g) => [g, summarise(eps.filter((e) => e.groups.includes(g)))])),
  groupCounts: Object.fromEntries(groupNames.map((g) => [g, eps.filter((e) => e.groups.includes(g)).length])),
  subjectDivergenceRmsM: { median: percentile(eps.map((e) => e.divergenceRmsM), 0.5), p90: percentile(eps.map((e) => e.divergenceRmsM), 0.9) },
  physicalLimits: {
    kalman: { minAglM: Math.min(...eps.map((e) => e.kalman.minAgl)), maxHSpeedMps: Math.max(...eps.map((e) => e.kalman.maxHSpeed)) },
    kalmanExactStart: { minAglM: Math.min(...eps.map((e) => e.kalmanExactStart.minAgl)), maxHSpeedMps: Math.max(...eps.map((e) => e.kalmanExactStart.maxHSpeed)) },
    ml: { minAglM: Math.min(...eps.map((e) => e.ml.minAgl)), maxHSpeedMps: Math.max(...eps.map((e) => e.ml.maxHSpeed)) },
  },
  learnedGuidance: { viewpointChoicesByLearned: eps.reduce((a, e) => a + e.learnedChoices, 0), fallbacksToKalmanViewpoint: eps.reduce((a, e) => a + e.fallbackChoices, 0), predictionTicks: eps.reduce((a, e) => a + e.beliefTicks, 0) },
  nodeOnnxLatencyMs: { calls: lat.length, p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), mean: lat.reduce((a, b) => a + b, 0) / (lat.length || 1), caveat: "Node wasm, not a browser; the browser number is in browser_smoke.json" },
  mlSimWallSecondsPerEpisode: { median: percentile(eps.map((e) => e.mlSimSeconds), 0.5), p90: percentile(eps.map((e) => e.mlSimSeconds), 0.9) },
  mlWorseEpisodes: { criterion: "ML total unobserved time exceeds Kalman's by more than 2 s", count: worse.length, of: eps.length, cases: worse },
  perEpisode: eps.map((e) => ({ id: e.id, groups: e.groups, kalman: { ...e.kalman, runs: undefined }, kalmanExactStart: { ...e.kalmanExactStart, runs: undefined }, ml: { ...e.ml, runs: undefined }, divergenceRmsM: e.divergenceRmsM })),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
console.error(JSON.stringify({ overall: report.overall, worse: worse.length, lat: report.nodeOnnxLatencyMs, minutes: ((performance.now() - t0) / 60000).toFixed(1) }, null, 1));
