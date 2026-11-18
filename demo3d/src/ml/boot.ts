/** Chooses how the page's Timeline is produced: Kalman (default, synchronous) or learned guidance (async, ONNX in this browser). */
import { DEFAULT_CONFIG, ML_STRIDE_STEPS, buildWorld, simulate, simulateGuided, type Timeline, type SimConfig } from "../sim/simulate";
import { buildRichWorld } from "../sim/richWorld";
import { simulatePolicy } from "../sim/policyRuntime";
import { LearnedModel, type ModelStatus } from "./model";

export const DEFAULT_MODEL_ID = "beliefview3d-search-v1";
export type GuidanceChoice = "kalman" | "ml";
export type BootStatus = ModelStatus | { state: "computing"; frac: number };

export interface Boot {
  requested: GuidanceChoice;
  /** What is actually driving the drone in `tl`. Differs from `requested` when the model failed to load/run. */
  active: GuidanceChoice;
  tl: Timeline;
  model: LearnedModel | null;
  error: string | null;
  regionLevel: number | null;
  /** Measured held-out coverage of the validation-calibrated region (final audit if present, else development test). */
  coverage: { label: string; value: number; samples: number; episodes: number } | null;
  manifestUrl: string | null;
}

export async function bootGuidance(q: URLSearchParams, baseUrl: string, onStatus: (s: BootStatus) => void, config: SimConfig = DEFAULT_CONFIG): Promise<Boot> {
  const rich = q.get("terrain") === "rich";
  const activePolicy = q.get("policy") === "active";
  const world = rich ? buildRichWorld(config) : buildWorld(config);
  const kalman = () => rich ? simulatePolicy(config, world, "kalman", async () => { throw new Error("Kalman must never infer"); }) : Promise.resolve(simulate(config, world, "coarse"));
  const requested: GuidanceChoice = q.get("guidance") === "ml" ? "ml" : "kalman";
  if (requested === "kalman") return { requested, active: "kalman", tl: await kalman(), model: null, error: null, regionLevel: null, coverage: null, manifestUrl: null };
  const manifestUrl = q.get("mlManifest") ?? `${baseUrl}models/${DEFAULT_MODEL_ID}/manifest.json`;
  let model: LearnedModel | null = null;
  try {
    const ort = (await import("./ortWeb")).default;
    model = await LearnedModel.load({ manifestUrl, ort, onStatus });
    const tl = rich || activePolicy ? await simulatePolicy(config, world, activePolicy ? "active" : "baseline", (f) => model!.predict(f), undefined, undefined, (frac) => onStatus({state:"computing", frac})) : await simulateGuided(config, world, (f) => model!.predict(f), { stride: ML_STRIDE_STEPS }, (frac) => onStatus({ state: "computing", frac }));
    onStatus({ state: "ready", modelId: model.manifest.modelId, version: model.manifest.modelVersion, sha256: model.info.sha256, bytes: model.info.bytes, loadMs: model.info.loadMs });
    return { requested, active: "ml", tl, model, error: null, regionLevel: model.manifest.calibration.region95.massLevel, coverage: measuredCoverage(model), manifestUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onStatus({ state: "error", message: msg });
    return { requested, active: "kalman", tl: await kalman(), model, error: msg, regionLevel: null, coverage: null, manifestUrl };
  }
}

function measuredCoverage(model: LearnedModel): Boot["coverage"] {
  const m = model.manifest.calibration.region95.measured;
  if (m?.finalAudit) return { label: "final audit", value: m.finalAudit.coverage, samples: m.finalAudit.samples, episodes: m.finalAudit.episodes };
  if (m?.developmentTest) return { label: "development test", value: m.developmentTest.coverage, samples: m.developmentTest.samples, episodes: m.developmentTest.episodes };
  return null;
}
