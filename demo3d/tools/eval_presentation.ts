/** Descriptive checks for the UI's three selected development replays. Not a new held-out audit. */
import { readFileSync, writeFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { SCENARIOS } from "../src/scenarioCatalog";
import { LearnedModel } from "../src/ml/model";
import { buildWorld, simulate, simulateGuided } from "../src/sim/simulate";
import { runOutcome, subjectDivergence, percentile } from "../src/ml/closedLoop";
import { meanXZ, hpdRegion, regionAreaM2 } from "../src/ml/belief";
import { CELL_M, GRID_N } from "../src/ml/features";
const model = await LearnedModel.load({ manifestUrl: "public/models/beliefview3d-search-v1/manifest.json", ort, fetchBytes: async (u) => new Uint8Array(readFileSync(u)) });
const examples = [];
for (const s of SCENARIOS) {
  const world = buildWorld(s.config);
  const k = simulate(s.config, world, "coarse");
  const m = await simulateGuided(s.config, world, (f) => model.predict(f));
  const errors: number[] = [], areas: number[] = [], covered: boolean[] = [];
  for (let j = 0; j < m.ml!.beliefs.length; j++) {
    const b = m.ml!.beliefs[j]; if (!b) continue;
    const f = m.frames[j * m.ml!.stride];
    const mean = meanXZ(b), region = hpdRegion(b, model.manifest.calibration.region95.massLevel);
    errors.push(Math.hypot(mean.x - f.subject.x, mean.z - f.subject.z));
    areas.push(regionAreaM2(region.cells));
    const col = Math.floor((f.subject.x - b.center.x) / CELL_M + GRID_N / 2);
    const row = Math.floor((f.subject.z - b.center.z) / CELL_M + GRID_N / 2);
    covered.push(row >= 0 && row < GRID_N && col >= 0 && col < GRID_N && !!region.mask[row * GRID_N + col]);
  }
  examples.push({ id: s.id, worldSeed: s.config.seed, subjectSeed: s.config.subjectSeed,
    kalman: runOutcome(k.frames), learned: runOutcome(m.frames), subjectPathDivergenceRmsM: subjectDivergence(k.frames, m.frames),
    learnedPredictionTicks: errors.length, medianLearnedMeanPositionErrorM: percentile(errors, .5),
    measuredRegionCoverage: covered.filter(Boolean).length / covered.length, medianRegionAreaM2: percentile(areas, .5),
    learnedChoices: m.ml!.guidance.learnedChoices, fallbackChoices: m.ml!.guidance.fallbacks });
}
writeFileSync("ml/results/search_story_examples.json", JSON.stringify({
  role: "Selected illustrative development examples, not a fresh audit or a generalization claim",
  modelSha256: model.info.sha256,
  limitations: "Three selected replays. Correlated prediction ticks are descriptive only; no confidence intervals or population claim. Subject paths react to guidance and diverge. Unreacquired losses are censored at episode end; firstLossReacquired and runs retain censoring. New worlds are within the same hand-written behavior family. Historical audit is unchanged and has now been inspected.",
  examples,
}, null, 2) + "\n");
console.log(JSON.stringify(examples.map((e) => ({ id: e.id, unobservedKalman: e.kalman.unobservedS, unobservedLearned: e.learned.unobservedS, coverage: e.measuredRegionCoverage, area: e.medianRegionAreaM2 }))));
