import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CELL_M, CHANNELS, EXTRACTOR_VERSION, GRID_N, SCALARS, SCALAR_NORM } from "../../src/ml/features";
import { POST_HEIGHT_M } from "../../src/render/mlOverlay";
import type { Manifest } from "../../src/ml/manifest";
import { MODEL_DIR } from "./helpers";

const root = new URL("../../", import.meta.url);
const manifest: Manifest = JSON.parse(readFileSync(MODEL_DIR + "manifest.json", "utf8"));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("manifest provenance is exact-content, not just a commit id", () => {
  it("every recorded source file hash matches the working tree (so the shipped model was trained with these exact sources)", () => {
    const sh = manifest.source.sourceSha256!;
    const files = Object.keys(sh.files);
    expect(files.length).toBeGreaterThan(8);
    expect(files).toEqual(expect.arrayContaining(["src/sim/simulate.ts", "src/sim/subject.ts", "src/ml/features.ts", "tools/gen_episodes.ts", "ml/belief_ml/episodes_cfg.py"]));
    for (const f of files) expect(sha(readFileSync(new URL(f, root))), f).toBe(sh.files[f]);
    const combined = sha(files.map((f) => `${f}\0${sh.files[f]}\n`).join(""));
    expect(combined).toBe(sh.combined);
  });
  it("feature schema hash equals the canonical JSON of this build's feature contract (the Python side builds the same string)", () => {
    const schema = {
      cellMeters: CELL_M, channels: [...CHANNELS], extractorVersion: EXTRACTOR_VERSION, gridN: GRID_N,
      scalars: SCALARS.map((n) => ({ max: SCALAR_NORM[n].max, min: SCALAR_NORM[n].min, name: n, scale: SCALAR_NORM[n].scale })),
    };
    expect(sha(JSON.stringify(schema))).toBe(manifest.source.featureSchemaSha256);
  });
  it("model feature contract has no start-position input and the manifest says so", () => {
    expect(SCALARS.join()).not.toMatch(/hint|start/);
    expect(manifest.model.inputs[1].shape).toEqual([1, SCALARS.length]);
    expect(manifest.features.grid.centre).toMatch(/never run before the first fix/);
  });
});

describe("calibration wording and evidence", () => {
  it("manifest describes the region as validation-calibrated with measured (not guaranteed) coverage", () => {
    const r = manifest.calibration.region95;
    expect(r.statement).toMatch(/Validation-calibrated/);
    expect(r.statement).toMatch(/measured, not guaranteed/);
    expect(r.measured?.developmentTest?.coverage).toBeGreaterThan(0);
    expect(r.measured?.finalAudit?.coverage).toBeGreaterThan(0);
  });
  it("UI copy no longer claims a 'Calibrated 95% region'", () => {
    const html = readFileSync(new URL("index.html", root), "utf8");
    expect(html).not.toMatch(/Calibrated 95% region/);
    expect(html).toMatch(/Validation-calibrated region \(target 95%\)/);
    expect(html).toMatch(/Measured held-out coverage/);
    expect(html).toMatch(/id="t-ml" disabled/); // unchecked by default: only the learned page enables and checks it
  });
});

describe("peak markers are short ground posts", () => {
  it("post height <= 1 m", () => expect(POST_HEIGHT_M).toBeLessThanOrEqual(1));
});
