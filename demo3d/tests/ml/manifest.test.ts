import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANNELS, SCALARS, SCALAR_NORM } from "../../src/ml/features";
import { MANIFEST_SCHEMA_VERSION, validateManifest, type Manifest } from "../../src/ml/manifest";
import { LearnedModel } from "../../src/ml/model";
import { sha256Fallback, sha256Hex } from "../../src/ml/sha256";
import { MODEL_DIR, fileBytes, ort } from "./helpers";

const manifest: Manifest = JSON.parse(readFileSync(MODEL_DIR + "manifest.json", "utf8"));
const clone = (): Manifest => JSON.parse(JSON.stringify(manifest));

describe("manifest", () => {
  it("shipped manifest passes the strict validator", () => {
    expect(validateManifest(manifest)).toEqual({ ok: true, errors: [] });
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.synthetic).toBe(true);
  });
  it("documents feature order, normalisation, grid, seeds, splits, architecture, source and hash", () => {
    expect(manifest.features.channels.map((c) => c.name)).toEqual([...CHANNELS]);
    expect(manifest.features.scalars.map((c) => [c.name, c.scale])).toEqual(SCALARS.map((n) => [n, SCALAR_NORM[n].scale]));
    expect(manifest.features.grid.n).toBe(32);
    expect(Object.keys(manifest.training.splits).sort()).toEqual(["test", "train", "val"]);
    const s = manifest.training.splits;
    expect(s.train.worldSeeds[1]).toBeLessThan(s.val.worldSeeds[0]);
    expect(s.val.worldSeeds[1]).toBeLessThan(s.test.worldSeeds[0]);
    expect(s.train.subjectSeeds[1]).toBeLessThan(s.val.subjectSeeds[0]);
    expect(s.val.subjectSeeds[1]).toBeLessThan(s.test.subjectSeeds[0]);
    expect(manifest.training.architecture.length).toBeGreaterThan(20);
    expect(manifest.source.generatorCommit.length).toBeGreaterThan(6);
    expect(manifest.training.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.limitations.length).toBeGreaterThan(0);
  });
  it("model.onnx matches the manifest size and sha256 (node crypto, WebCrypto path and pure-JS fallback agree)", async () => {
    const bytes = readFileSync(MODEL_DIR + manifest.model.file);
    expect(bytes.length).toBe(manifest.model.bytes);
    const ref = createHash("sha256").update(bytes).digest("hex");
    expect(ref).toBe(manifest.model.sha256);
    expect(await sha256Hex(new Uint8Array(bytes))).toBe(ref);
    expect(sha256Fallback(new Uint8Array(bytes))).toBe(ref);
    expect(sha256Fallback(new Uint8Array([97, 98, 99]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  const mutations: [string, (m: Manifest) => void][] = [
    ["schemaVersion", (m) => { m.schemaVersion = 2; }],
    ["synthetic flag", (m) => { (m as unknown as { synthetic: boolean }).synthetic = false; }],
    ["bad hash", (m) => { m.model.sha256 = "xyz"; }],
    ["path traversal in file", (m) => { m.model.file = "../model.onnx"; }],
    ["channel order", (m) => { m.features.channels.reverse(); }],
    ["scalar normalisation", (m) => { m.features.scalars[0].scale = 31; }],
    ["scalar order", (m) => { m.features.scalars.reverse(); }],
    ["extractor version", (m) => { m.features.extractorVersion = 99; }],
    ["grid size", (m) => { m.features.grid.n = 16; }],
    ["input shape", (m) => { m.model.inputs[0].shape = [1, 7, 32, 32]; }],
    ["output name", (m) => { m.model.outputs[0].name = "logits"; }],
    ["softmax flag", (m) => { m.output.softmaxInGraph = false; }],
    ["calibration level", (m) => { m.calibration.region95.massLevel = 1.5; }],
    ["limitations removed", (m) => { m.limitations = []; }],
    ["missing training block", (m) => { delete (m as Partial<Manifest>).training; }],
  ];
  it.each(mutations)("rejects a manifest with a bad %s", (_n, mut) => {
    const m = clone();
    mut(m);
    expect(validateManifest(m).ok).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });
});

describe("loader fails closed", () => {
  const good = (u: string) => fileBytes(u);
  it("loads the real model and reports ready", async () => {
    const seen: string[] = [];
    const m = await LearnedModel.load({ manifestUrl: MODEL_DIR + "manifest.json", ort, fetchBytes: good, onStatus: (s) => seen.push(s.state) });
    expect(seen).toContain("loading");
    expect(seen[seen.length - 1]).toBe("ready");
    expect(m.info.sha256).toBe(manifest.model.sha256);
  });
  it("rejects model bytes whose hash differs from the manifest", async () => {
    const seen: string[] = [];
    const tampered = async (u: string) => { const b = await fileBytes(u); if (u.endsWith(".onnx")) b[b.length - 1] ^= 1; return b; };
    await expect(LearnedModel.load({ manifestUrl: MODEL_DIR + "manifest.json", ort, fetchBytes: tampered, onStatus: (s) => seen.push(s.state) })).rejects.toThrow(/sha256 mismatch/);
    expect(seen[seen.length - 1]).toBe("error");
  });
  it("rejects a size mismatch, an invalid manifest and a missing file", async () => {
    const trunc = async (u: string) => { const b = await fileBytes(u); return u.endsWith(".onnx") ? b.slice(0, b.length - 3) : b; };
    await expect(LearnedModel.load({ manifestUrl: MODEL_DIR + "manifest.json", ort, fetchBytes: trunc })).rejects.toThrow(/size/);
    const badManifest = async (u: string) => { const b = await fileBytes(u); if (!u.endsWith(".json")) return b; const m = JSON.parse(new TextDecoder().decode(b)); m.schemaVersion = 7; return new TextEncoder().encode(JSON.stringify(m)); };
    await expect(LearnedModel.load({ manifestUrl: MODEL_DIR + "manifest.json", ort, fetchBytes: badManifest })).rejects.toThrow(/manifest rejected/);
    await expect(LearnedModel.load({ manifestUrl: MODEL_DIR + "nope.json", ort, fetchBytes: good })).rejects.toThrow(/manifest unreadable/);
  });
});
