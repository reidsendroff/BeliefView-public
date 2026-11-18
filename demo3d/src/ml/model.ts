/** Loads + validates the exported ONNX model and runs it. The ONNX runtime module is injected (onnxruntime-web in browser/Node). */
import type * as OrtNs from "onnxruntime-web";
import { GRID_N, type FeatureOutput } from "./features";
import { validateManifest, type Manifest } from "./manifest";
import { sha256Hex } from "./sha256";

export type OrtModule = typeof OrtNs;
export type ModelStatus =
  | { state: "idle" }
  | { state: "loading"; detail: string }
  | { state: "ready"; modelId: string; version: string; sha256: string; bytes: number; loadMs: number }
  | { state: "error"; message: string };

export class ModelLoadError extends Error {}

export interface LoadOptions {
  manifestUrl: string;
  ort: OrtModule;
  /** Defaults to global fetch. Tests/Node supply a file-backed one. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  onStatus?: (s: ModelStatus) => void;
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new ModelLoadError(`GET ${url} failed: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export interface InferenceStats { calls: number; totalMs: number; lastMs: number; samplesMs: number[] }

export class LearnedModel {
  stats: InferenceStats = { calls: 0, totalMs: 0, lastMs: 0, samplesMs: [] };
  private constructor(public readonly manifest: Manifest, private session: OrtNs.InferenceSession, private ort: OrtModule, public readonly info: { sha256: string; bytes: number; loadMs: number }) {}

  static async load(opts: LoadOptions): Promise<LearnedModel> {
    const fetchBytes = opts.fetchBytes ?? defaultFetch;
    const status = opts.onStatus ?? (() => {});
    const t0 = performance.now();
    try {
      status({ state: "loading", detail: "fetching manifest" });
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(await fetchBytes(opts.manifestUrl))); }
      catch (e) { throw new ModelLoadError(`manifest unreadable: ${(e as Error).message}`); }
      const v = validateManifest(raw);
      if (!v.ok) throw new ModelLoadError(`manifest rejected: ${v.errors.slice(0, 3).join("; ")}`);
      const m = raw as Manifest;
      status({ state: "loading", detail: "fetching model weights" });
      const bytes = await fetchBytes(opts.manifestUrl.slice(0, opts.manifestUrl.lastIndexOf("/") + 1) + m.model.file);
      if (bytes.length !== m.model.bytes) throw new ModelLoadError(`model size ${bytes.length} != manifest ${m.model.bytes}`);
      const hash = await sha256Hex(bytes);
      if (hash !== m.model.sha256) throw new ModelLoadError(`model sha256 mismatch (manifest ${m.model.sha256.slice(0, 12)}…, file ${hash.slice(0, 12)}…)`);
      status({ state: "loading", detail: "starting ONNX runtime" });
      const session = await opts.ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all", intraOpNumThreads: 1 });
      if (session.inputNames.join() !== "grid,scalars" || session.outputNames.join() !== "prob") throw new ModelLoadError(`model I/O names ${session.inputNames}/${session.outputNames} do not match manifest`);
      const lm = new LearnedModel(m, session, opts.ort, { sha256: hash, bytes: bytes.length, loadMs: 0 });
      // Warm-up + smoke check that the graph produces a valid distribution.
      const zero: FeatureOutput = { grid: new Float32Array(m.features.channels.length * GRID_N * GRID_N), codes: new Uint8Array(0), scalars: new Float32Array(m.features.scalars.length), center: { x: 0, z: 0 }, t: 0, elapsed: 0, hasFix: false };
      await lm.predict(zero);
      lm.stats = { calls: 0, totalMs: 0, lastMs: 0, samplesMs: [] };
      (lm.info as { loadMs: number }).loadMs = performance.now() - t0;
      status({ state: "ready", modelId: m.modelId, version: m.modelVersion, sha256: hash, bytes: bytes.length, loadMs: lm.info.loadMs });
      return lm;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status({ state: "error", message: msg });
      throw e instanceof ModelLoadError ? e : new ModelLoadError(msg);
    }
  }

  /** Runs one inference; validates that the output is a finite probability grid. */
  async predict(f: Pick<FeatureOutput, "grid" | "scalars">): Promise<Float32Array> {
    const t0 = performance.now();
    const feeds = {
      grid: new this.ort.Tensor("float32", f.grid, [1, this.manifest.features.channels.length, GRID_N, GRID_N]),
      scalars: new this.ort.Tensor("float32", f.scalars, [1, this.manifest.features.scalars.length]),
    };
    const out = await this.session.run(feeds);
    const prob = out.prob.data as Float32Array;
    const dt = performance.now() - t0;
    if (prob.length !== GRID_N * GRID_N) throw new ModelLoadError(`model output has ${prob.length} values, expected ${GRID_N * GRID_N}`);
    let sum = 0;
    for (let k = 0; k < prob.length; k++) { if (!Number.isFinite(prob[k]) || prob[k] < 0) throw new ModelLoadError("model produced a non-finite or negative probability"); sum += prob[k]; }
    if (Math.abs(sum - 1) > 1e-3) throw new ModelLoadError(`model output sums to ${sum}, expected 1`);
    this.stats.calls++; this.stats.totalMs += dt; this.stats.lastMs = dt;
    if (this.stats.samplesMs.length < 5000) this.stats.samplesMs.push(dt);
    return Float32Array.from(prob);
  }

  async dispose(): Promise<void> { await this.session.release(); }
}
