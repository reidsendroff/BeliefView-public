/**
 * Generate JSONL(.gz) training/eval samples from the REAL TypeScript simulator (no Python mirror of the subject policy).
 *
 *   npx tsx tools/gen_episodes.ts --split train --count 200 --out ml/data/train.jsonl.gz [--first 0] [--workers 1]
 *
 * Data-collection policy: Kalman guidance with the same coarse start set-up the learned run uses (no exact start). Each sample is a 1 Hz prediction tick while the fix is missing.
 * The model input (`g` uint8 grid codes, `sc` scalars) comes from the SAME FeatureExtractor used at inference. Labels (`y`,
 * `yc`) and scenario `tags` come from recorded subject truth and are never fed to the model.
 */
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createGzip } from "node:zlib";
import { cellOf, GRID_N } from "../src/ml/features";
import { episodeConfig, splitSeeds, type SplitName } from "../src/ml/episodes";
import { replayFeatures } from "../src/ml/replay";
import { lostRuns, runOf, sampleTags } from "../src/ml/scenarios";
import { buildWorld, ML_STRIDE_STEPS, simulate } from "../src/sim/simulate";

function arg(name: string, def?: string): string {
  const k = process.argv.indexOf(`--${name}`);
  if (k >= 0 && process.argv[k + 1]) return process.argv[k + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

const split = arg("split") as SplitName;
const count = Number(arg("count"));
const first = Number(arg("first", "0"));
const out = arg("out");
mkdirSync(dirname(out), { recursive: true });
const gz = createGzip({ level: 6 });
gz.pipe(createWriteStream(out));

let samples = 0, outside = 0;
const t0 = performance.now();
for (let k = first; k < first + count; k++) {
  const { worldSeed, subjectSeed } = splitSeeds(split, k);
  const cfg = episodeConfig(worldSeed, subjectSeed);
  const world = buildWorld(cfg);
  const tl = simulate(cfg, world, "coarse"); // same coarse set-up the learned run uses at inference
  const runs = lostRuns(tl.frames);
  replayFeatures(tl.frames, world, ML_STRIDE_STEPS, (i, f) => {
    const fr = tl.frames[i];
    const run = runOf(runs, i);
    const cell = cellOf(f.center, fr.subject.x, fr.subject.z);
    if (!cell) outside++;
    const rec = {
      ep: `${split}-${k}`, split, w: worldSeed, s: subjectSeed, i, t: fr.t, el: f.elapsed, hf: f.hasFix,
      c: [f.center.x, f.center.z],
      g: Buffer.from(f.codes).toString("base64"),
      sc: Array.from(f.scalars),
      y: [fr.subject.x, fr.subject.z],
      yc: cell ? [cell.i, cell.j] : null,
      kal: [fr.track.x, fr.track.z, fr.track.radius, fr.track.initialised],
      tags: run ? sampleTags(tl.frames, i, run) : { hide: false, turn: false, long: false, reacq: false },
      run: run ? run.i0 : -1,
    };
    gz.write(JSON.stringify(rec) + "\n");
    samples++;
  });
}
gz.end(() => {
  console.error(JSON.stringify({ split, episodes: count, samples, truthOutsideGrid: outside, grid: GRID_N, seconds: Number(((performance.now() - t0) / 1000).toFixed(1)) }));
});
