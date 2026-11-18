/** Versioned model manifest: strict structural validator (hand-written; the source of truth for the schema). */
import { CELL_M, CHANNELS, EXTRACTOR_VERSION, GRID_N, SCALARS, SCALAR_NORM } from "./features";

export const MANIFEST_SCHEMA_VERSION = 1;
export const SUPPORTED_MODEL_FORMAT = "onnx";

/** Coverage actually measured on held-out episodes for the validation-calibrated region (not a guarantee). */
export interface MeasuredCoverage { split: string; coverage: number; samples: number; episodes: number; medianAreaM2: number }

export interface Manifest {
  schemaVersion: number;
  modelId: string;
  modelVersion: string;
  synthetic: true;
  description: string;
  model: {
    file: string;
    format: "onnx";
    sha256: string;
    bytes: number;
    opset: number;
    inputs: { name: string; shape: number[]; dtype: "float32" }[];
    outputs: { name: string; shape: number[]; dtype: "float32" }[];
  };
  features: {
    extractorVersion: number;
    grid: { n: number; cellMeters: number; centre: string; layout: string };
    channels: { index: number; name: string; description: string }[];
    gridQuantisation: string;
    scalars: { index: number; name: string; scale: number; min: number; max: number }[];
  };
  output: { name: string; interpretation: string; softmaxInGraph: boolean };
  calibration: { region95: { massLevel: number; fitSplit: string; fitSamples: number; targetCoverage: number; statement?: string; measured?: { developmentTest?: MeasuredCoverage; finalAudit?: MeasuredCoverage } } };
  training: {
    architecture: string;
    parameters: number;
    seeds: Record<string, number>;
    splits: Record<string, { worldSeeds: number[]; subjectSeeds: number[]; episodes: number; samples: number }>;
    loss: string;
    framework: string;
    device: string;
    datasetSha256: string;
    notebook: string;
  };
  source: { repository: string; generatorCommit: string; generatorCommitNote?: string; simulator: string; sourceSha256?: { combined: string; files: Record<string, string> }; featureSchemaSha256?: string };
  limitations: string[];
}

export interface ValidationResult { ok: boolean; errors: string[] }

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export function validateManifest(m: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (s: string) => errors.push(s);
  if (!isObj(m)) return { ok: false, errors: ["manifest is not an object"] };
  const str = (o: Rec, k: string, path: string) => { if (typeof o[k] !== "string" || (o[k] as string).length === 0) err(`${path}.${k} must be a non-empty string`); };
  const num = (o: Rec, k: string, path: string) => { if (typeof o[k] !== "number" || !Number.isFinite(o[k] as number)) err(`${path}.${k} must be a finite number`); };
  const obj = (o: Rec, k: string, path: string): Rec | null => { if (!isObj(o[k])) { err(`${path}.${k} must be an object`); return null; } return o[k] as Rec; };

  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) err(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION} (got ${String(m.schemaVersion)})`);
  str(m, "modelId", "manifest"); str(m, "modelVersion", "manifest"); str(m, "description", "manifest");
  if (m.synthetic !== true) err("manifest.synthetic must be true (models here are trained on synthetic simulator data only)");

  const model = obj(m, "model", "manifest");
  if (model) {
    str(model, "file", "model");
    if (typeof model.file === "string" && !/^[A-Za-z0-9._-]+$/.test(model.file)) err("model.file must be a plain file name (no path)");
    if (model.format !== SUPPORTED_MODEL_FORMAT) err("model.format must be onnx");
    if (typeof model.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(model.sha256)) err("model.sha256 must be 64 lowercase hex characters");
    num(model, "bytes", "model"); num(model, "opset", "model");
    const io = (k: "inputs" | "outputs") => {
      const arr = model[k];
      if (!Array.isArray(arr) || arr.length === 0) { err(`model.${k} must be a non-empty array`); return []; }
      for (const e of arr) if (!isObj(e) || typeof e.name !== "string" || !Array.isArray(e.shape) || e.dtype !== "float32") err(`model.${k} entries need name, shape[], dtype=float32`);
      return arr as { name: string; shape: number[] }[];
    };
    const ins = io("inputs"), outs = io("outputs");
    const shapeIs = (e: { shape: number[] } | undefined, s: number[]) => !!e && e.shape.length === s.length && e.shape.every((d, i) => d === s[i]);
    if (!(ins.length === 2 && ins[0].name === "grid" && shapeIs(ins[0], [1, CHANNELS.length, GRID_N, GRID_N]))) err(`model.inputs[0] must be grid ${JSON.stringify([1, CHANNELS.length, GRID_N, GRID_N])}`);
    if (!(ins.length === 2 && ins[1].name === "scalars" && shapeIs(ins[1], [1, SCALARS.length]))) err(`model.inputs[1] must be scalars ${JSON.stringify([1, SCALARS.length])}`);
    if (!(outs.length === 1 && outs[0].name === "prob" && shapeIs(outs[0], [1, GRID_N * GRID_N]))) err(`model.outputs[0] must be prob ${JSON.stringify([1, GRID_N * GRID_N])}`);
  }

  const feats = obj(m, "features", "manifest");
  if (feats) {
    if (feats.extractorVersion !== EXTRACTOR_VERSION) err(`features.extractorVersion must be ${EXTRACTOR_VERSION} (this build)`);
    const g = obj(feats, "grid", "features");
    if (g && (g.n !== GRID_N || g.cellMeters !== CELL_M)) err(`features.grid must be n=${GRID_N}, cellMeters=${CELL_M}`);
    const ch = feats.channels;
    if (!Array.isArray(ch) || ch.length !== CHANNELS.length || ch.some((c, i) => !isObj(c) || c.index !== i || c.name !== CHANNELS[i])) err(`features.channels must be exactly [${CHANNELS.join(", ")}] in order`);
    const sc = feats.scalars;
    if (!Array.isArray(sc) || sc.length !== SCALARS.length || sc.some((c, i) => !isObj(c) || c.index !== i || c.name !== SCALARS[i]
      || c.scale !== SCALAR_NORM[SCALARS[i]].scale || c.min !== SCALAR_NORM[SCALARS[i]].min || c.max !== SCALAR_NORM[SCALARS[i]].max)) err("features.scalars must match this build's feature order and normalisation exactly");
  }

  const out = obj(m, "output", "manifest");
  if (out) { str(out, "interpretation", "output"); if (out.name !== "prob") err("output.name must be prob"); if (out.softmaxInGraph !== true) err("output.softmaxInGraph must be true"); }

  const cal = obj(m, "calibration", "manifest");
  const r95 = cal ? obj(cal, "region95", "calibration") : null;
  if (r95) {
    num(r95, "massLevel", "calibration.region95");
    const lv = r95.massLevel as number;
    if (typeof lv === "number" && !(lv > 0 && lv <= 1)) err("calibration.region95.massLevel must be in (0, 1]");
    const meas = r95.measured;
    if (meas !== undefined) {
      if (!isObj(meas)) err("calibration.region95.measured must be an object");
      else for (const k of ["developmentTest", "finalAudit"]) {
        const e = meas[k];
        if (e === undefined) continue;
        if (!isObj(e) || typeof e.coverage !== "number" || !(e.coverage >= 0 && e.coverage <= 1) || typeof e.samples !== "number" || typeof e.episodes !== "number") err(`calibration.region95.measured.${k} needs coverage in [0,1], samples, episodes`);
      }
    }
  }
  const tr = obj(m, "training", "manifest");
  if (tr) { str(tr, "architecture", "training"); str(tr, "datasetSha256", "training"); obj(tr, "seeds", "training"); obj(tr, "splits", "training"); }
  const src = obj(m, "source", "manifest");
  if (src) {
    str(src, "repository", "source"); str(src, "generatorCommit", "source");
    const sh = src.sourceSha256;
    if (!isObj(sh) || typeof sh.combined !== "string" || !/^[0-9a-f]{64}$/.test(sh.combined) || !isObj(sh.files) || Object.keys(sh.files).length === 0) err("source.sourceSha256 must hold the combined hash and per-file SHA-256 of the exact source files");
    if (typeof src.featureSchemaSha256 !== "string" || !/^[0-9a-f]{64}$/.test(src.featureSchemaSha256)) err("source.featureSchemaSha256 must be 64 lowercase hex characters");
  }
  if (!Array.isArray(m.limitations) || m.limitations.length === 0) err("manifest.limitations must list at least one limitation");
  return { ok: errors.length === 0, errors };
}
