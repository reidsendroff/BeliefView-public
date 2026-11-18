/** Development/frozen audit evaluator. No model fitting, no truth enters policy. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as ort from "onnxruntime-web";
import { LearnedModel } from "../src/ml/model";
import { episodeConfig } from "../src/ml/episodes";
import { lineOfSight } from "../src/sim/geometry";
import { buildWorld } from "../src/sim/simulate";
import {
  buildRichWorld,
  inWater,
  isCoverPrimitive,
} from "../src/sim/richWorld";
import { simulatePolicy, type PolicyChoice } from "../src/sim/policyRuntime";
import { runOutcome, subjectDivergence, paired } from "../src/ml/closedLoop";
import { ACTIVE_OPTIONS, type ActiveOptions } from "../src/ml/activeGuidance";
import { meanXZ, hpdRegion, regionAreaM2 } from "../src/ml/belief";
import { GRID_N, CELL_M } from "../src/ml/features";
const arg = (key: string, def: string) => {
  const i = process.argv.indexOf("--" + key);
  return i < 0 ? def : process.argv[i + 1];
};
const role = arg("role", "development"),
  count = Number(arg("count", "32")),
  seed = Number(arg("seed", "80000")),
  subjectSeed = Number(arg("subject", "85000")),
  families = arg("families", "original,rich").split(","),
  arms = arg("arms", "kalman,baseline,active").split(",") as PolicyChoice[],
  out = arg("out", "ml/results/active_development.json");
const options: ActiveOptions = {
  ...ACTIVE_OPTIONS,
  novelty: Number(arg("novelty", String(ACTIVE_OPTIONS.novelty))),
  exploration: Number(arg("exploration", String(ACTIVE_OPTIONS.exploration))),
  routing: arg("routing", "1") === "1",
};
const freezePath = arg("freeze", "");
let freeze: any = null;
if (role === "audit") {
  if (!freezePath)
    throw new Error(
      "Audit requires a pre-existing frozen protocol and source hashes",
    );
  freeze = JSON.parse(readFileSync(freezePath, "utf8"));
  for (const [p, h] of Object.entries(freeze.hashes))
    if (createHash("sha256").update(readFileSync(p)).digest("hex") !== h)
      throw new Error("Frozen source mismatch: " + p);
  const expected = freeze.protocol;
  for (const [key, value] of Object.entries({
    role,
    count,
    seed,
    subjectSeed,
    families,
    arms,
    options,
  }))
    if (JSON.stringify(value) !== JSON.stringify(expected[key]))
      throw new Error("Protocol mismatch: " + key);
}
const model = await LearnedModel.load({
  manifestUrl: "public/models/beliefview3d-search-v1/manifest.json",
  ort,
  fetchBytes: async (u) => new Uint8Array(readFileSync(u)),
});
const rows: any[] = [];
const sourceFiles = [
  "src/ml/activeGuidance.ts",
  "src/ml/navigation.ts",
  "src/sim/policyRuntime.ts",
  "src/sim/richWorld.ts",
  "src/sim/richSubject.ts",
  "tools/eval_active.ts",
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((f) => [
    f,
    createHash("sha256").update(readFileSync(f)).digest("hex"),
  ]),
);
for (let n = 0; n < count; n++)
  for (const family of families) {
    const cfg = episodeConfig(seed + n, subjectSeed + n),
      world = family === "rich" ? buildRichWorld(cfg) : buildWorld(cfg),
      results: any = {},
      timelines: any = {};
    for (const arm of arms) {
      const started = performance.now(),
        inferenceStart = model.stats.totalMs,
        inferenceCallsStart = model.stats.calls;
      const tl = await simulatePolicy(
        cfg,
        world,
        arm,
        (f) => model.predict(f),
        options,
      );
      timelines[arm] = tl;
      const fr = tl.frames,
        dt = cfg.dt;
      let noFix = 0,
        travel = 0,
        stall = 0,
        waterFrames = 0;
      const used: Record<string, number> = {},
        shielded: Record<string, number> = {};
      for (let i = 0; i < fr.length - 1; i++) {
        const f = fr[i];
        if (!f.obs) noFix += dt;
        travel += Math.hypot(
          fr[i + 1].drone.x - f.drone.x,
          fr[i + 1].drone.z - f.drone.z,
        );
        if (
          f.mode === "SEARCH" &&
          Math.hypot(f.drone.vx, f.drone.vz) < 0.5 &&
          f.viewpoint &&
          Math.hypot(f.viewpoint.x - f.drone.x, f.viewpoint.z - f.drone.z) > 3
        )
          stall += dt;
        if (f.subject.action === "HIDE" && f.subject.cover >= 0) {
          const c = world.trees[f.subject.cover];
          if (c && isCoverPrimitive(c)) {
            used[c.coverKind] = (used[c.coverKind] ?? 0) + dt;
            const own = {
              ...world,
              trees: world.trees.filter(
                (t) => isCoverPrimitive(t) && t.coverId === c.coverId,
              ),
            };
            const block = lineOfSight(own, f.drone, {
              x: f.subject.x,
              z: f.subject.z,
              y: f.subject.y + 1.3 - 0.65 * f.subject.crouch,
            });
            if (block === "CANOPY" || block === "TRUNK")
              shielded[c.coverKind] = (shielded[c.coverKind] ?? 0) + dt;
          }
        }
      }
      waterFrames = fr.filter((f) =>
        inWater(world, f.subject.x, f.subject.z),
      ).length;
      const errors: number[] = [],
        areas: number[] = [],
        coverage: number[] = [];
      for (let k = 0; k < (tl.ml?.beliefs.length ?? 0); k++) {
        const b = tl.ml!.beliefs[k];
        if (!b) continue;
        const f = fr[k * tl.ml!.stride],
          mean = meanXZ(b),
          region = hpdRegion(b, model.manifest.calibration.region95.massLevel);
        errors.push(Math.hypot(mean.x - f.subject.x, mean.z - f.subject.z));
        areas.push(regionAreaM2(region.cells));
        const x = Math.floor((f.subject.x - b.center.x) / CELL_M + GRID_N / 2),
          z = Math.floor((f.subject.z - b.center.z) / CELL_M + GRID_N / 2);
        coverage.push(
          x >= 0 &&
            x < GRID_N &&
            z >= 0 &&
            z < GRID_N &&
            region.mask[z * GRID_N + x]
            ? 1
            : 0,
        );
      }
      const median = (a: number[]) =>
        a.length
          ? [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)]
          : null;
      results[arm] = {
        totalNoFixS: noFix,
        initialAcquisitionS: fr.find((f) => f.obs)?.t ?? cfg.duration,
        initialAcquired: fr.some((f) => f.obs),
        historical: runOutcome(fr),
        horizontalTravelM: travel,
        stallS: stall,
        waterFrames,
        selectedCoverHideSeconds: used,
        selectedCoverActuallyShieldedSeconds: shielded,
        rawModel: {
          ticks: errors.length,
          meanPositionErrorMedianM: median(errors),
          coverage: coverage.length
            ? coverage.reduce((a, b) => a + b, 0) / coverage.length
            : null,
          regionAreaMedianM2: median(areas),
        },
        wallMs: performance.now() - started,
        inferenceMs: model.stats.totalMs - inferenceStart,
        inferenceCalls: model.stats.calls - inferenceCallsStart,
        policyStats: tl.policy?.stats,
      };
    }
    rows.push({
      seed: seed + n,
      subjectSeed: subjectSeed + n,
      family,
      results,
      pathDivergenceBaselineActiveM:
        timelines.baseline && timelines.active
          ? subjectDivergence(
              timelines.baseline.frames,
              timelines.active.frames,
            )
          : null,
    });
    console.log(
      `${role} ${n + 1}/${count} ${family}: ${Object.entries(results)
        .map(([a, r]: any) => a + "=" + r.totalNoFixS.toFixed(1))
        .join(" ")}`,
    );
  }
function labelPair(
  p: ReturnType<typeof paired>,
  comparator: string,
  candidate: string,
) {
  const {
    meanKalman,
    meanMl,
    meanDiffMlMinusKalman,
    mlBetter,
    mlWorse,
    ...rest
  } = p;
  return {
    comparator,
    candidate,
    comparatorMean: meanKalman,
    candidateMean: meanMl,
    meanCandidateMinusComparator: meanDiffMlMinusKalman,
    candidateBetter: mlBetter,
    candidateWorse: mlWorse,
    ...rest,
  };
}
const descriptive = Object.fromEntries(
  families.map((family) => [
    family,
    Object.fromEntries(
      arms.map((arm) => {
        const rs = rows
          .filter((r) => r.family === family)
          .map((r) => r.results[arm]);
        const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
        const median = (a: number[]) =>
          [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
        return [
          arm,
          {
            episodes: rs.length,
            totalNoFixMeanS: mean(rs.map((r) => r.totalNoFixS)),
            totalNoFixMedianS: median(rs.map((r) => r.totalNoFixS)),
            neverAcquired: rs.filter((r) => !r.initialAcquired).length,
            initialAcquisitionCensoredMeanS: mean(
              rs.map((r) => r.initialAcquisitionS),
            ),
            unreacquiredLossRuns: rs.reduce(
              (s, r) =>
                s + r.historical.runs.filter((v: any) => !v.reacquired).length,
              0,
            ),
            horizontalTravelMeanM: mean(rs.map((r) => r.horizontalTravelM)),
            stallMeanS: mean(rs.map((r) => r.stallS)),
            waterFrames: rs.reduce((s, r) => s + r.waterFrames, 0),
            nodeEpisodeWallMedianMs: median(rs.map((r) => r.wallMs)),
            rawModelCoverageEpisodeMean: rs.some(
              (r) => r.rawModel.coverage !== null,
            )
              ? mean(
                  rs
                    .filter((r) => r.rawModel.coverage !== null)
                    .map((r) => r.rawModel.coverage),
                )
              : null,
            rawModelRegionAreaEpisodeMedianM2: rs.some(
              (r) => r.rawModel.regionAreaMedianM2 !== null,
            )
              ? median(
                  rs
                    .filter((r) => r.rawModel.regionAreaMedianM2 !== null)
                    .map((r) => r.rawModel.regionAreaMedianM2),
                )
              : null,
          },
        ];
      }),
    ),
  ]),
);
const summary = Object.fromEntries(
  families.map((family) => {
    const sel = rows.filter((r) => r.family === family);
    const comparisons: any = {};
    for (const base of ["baseline", "kalman"])
      if (arms.includes(base as PolicyChoice) && arms.includes("active")) {
        comparisons[base] = {
          totalNoFixS: labelPair(
            paired(
              sel.map((r) => r.results[base].totalNoFixS),
              sel.map((r) => r.results.active.totalNoFixS),
            ),
            base,
            "active",
          ),
          worseOver2S: sel
            .filter(
              (r) =>
                r.results.active.totalNoFixS - r.results[base].totalNoFixS > 2,
            )
            .map((r) => ({
              seed: r.seed,
              delta: r.results.active.totalNoFixS - r.results[base].totalNoFixS,
            })),
        };
      }
    return [family, comparisons];
  }),
);
if (freeze)
  for (const [p, h] of Object.entries(freeze.hashes))
    if (createHash("sha256").update(readFileSync(p)).digest("hex") !== h)
      throw new Error("Source changed during audit: " + p);
mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      role,
      count,
      seed,
      subjectSeed,
      families,
      arms,
      options,
      freezeSha256: freezePath
        ? createHash("sha256").update(readFileSync(freezePath)).digest("hex")
        : null,
      protocol: freeze?.protocol ?? null,
      modelSha256: model.info.sha256,
      sourceHashes,
      primary:
        "Total no-observation time over 1500 intervals from t0; never-seen counts 75 s. Rich family active vs frozen baseline is primary; original-family and Kalman comparisons are secondary. Families analyzed separately, paired by scenario; correlated ticks not independent. Censoring kept in historical.runs. Raw model coverage not recalibrated. Subject paths differ by policy.",
      descriptive,
      summary,
      rows,
    },
    null,
    2,
  ) + "\n",
);
