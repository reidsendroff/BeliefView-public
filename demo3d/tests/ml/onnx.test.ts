import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { episodeConfig } from "../../src/ml/episodes";
import { replayFeatures } from "../../src/ml/replay";
import { buildWorld, simulate } from "../../src/sim/simulate";
import { loadModel } from "./helpers";

interface Fixture { tolerance: number; samples: { worldSeed: number; subjectSeed: number; frame: number; codes_b64: string; scalars: number[]; prob: number[] }[] }
const fx: Fixture = JSON.parse(readFileSync(new URL("../../ml/fixtures/parity.json", import.meta.url), "utf8"));

describe("ONNX parity with the training notebook (torch) on fixed fixtures", () => {
  it("has fixtures", () => expect(fx.samples.length).toBeGreaterThanOrEqual(8));

  it("onnxruntime-web reproduces torch probabilities within the fixture tolerance and sums to 1", async () => {
    const model = await loadModel();
    let worst = 0;
    for (const s of fx.samples) {
      const codes = Buffer.from(s.codes_b64, "base64");
      const grid = Float32Array.from(codes, (c) => Math.fround(c / 255));
      const prob = await model.predict({ grid, scalars: Float32Array.from(s.scalars) });
      let sum = 0;
      prob.forEach((p, k) => { worst = Math.max(worst, Math.abs(p - s.prob[k])); sum += p; });
      expect(sum).toBeCloseTo(1, 4);
    }
    expect(worst).toBeLessThan(fx.tolerance);
  });

  it("TypeScript extractor regenerates the exact training features for the fixture episodes (bitwise)", () => {
    for (const s of fx.samples) {
      const cfg = episodeConfig(s.worldSeed, s.subjectSeed);
      const world = buildWorld(cfg);
      const tl = simulate(cfg, world, "coarse");
      let got: { codes: Uint8Array; scalars: Float32Array } | null = null;
      replayFeatures(tl.frames, world, 20, (i, f) => { if (i === s.frame) got = f; });
      expect(got, `frame ${s.frame} of ${s.worldSeed}/${s.subjectSeed}`).not.toBeNull();
      expect(Buffer.from(got!.codes).toString("base64")).toBe(s.codes_b64);
      expect(Array.from(got!.scalars)).toEqual(s.scalars.map((v) => Math.fround(v)));
    }
  }, 60000);
});
