import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { LearnedModel } from "../../src/ml/model";

export const MODEL_DIR = new URL("../../public/models/beliefview3d-search-v1/", import.meta.url).pathname;
export const fileBytes = async (p: string) => new Uint8Array(readFileSync(p));
let cached: Promise<LearnedModel> | null = null;
export function loadModel(): Promise<LearnedModel> {
  cached ??= LearnedModel.load({ manifestUrl: MODEL_DIR + "manifest.json", ort, fetchBytes: fileBytes });
  return cached;
}
export { ort };
