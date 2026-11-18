/** Freeze a candidate and the untouched final-audit protocol. Does not generate any final world. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ACTIVE_OPTIONS } from "../src/ml/activeGuidance";
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
const paths = [
  ...walk("src/sim"),
  ...walk("src/ml"),
  "tools/eval_active.ts",
  "tools/freeze_active.ts",
  "package.json",
  "package-lock.json",
  "public/models/beliefview3d-search-v1/manifest.json",
  "public/models/beliefview3d-search-v1/model.onnx",
];
const hashes = Object.fromEntries(
  paths.map((p) => [
    p,
    createHash("sha256").update(readFileSync(p)).digest("hex"),
  ]),
);
const protocol = {
  role: "audit",
  count: 60,
  seed: 120000,
  subjectSeed: 125000,
  families: ["original", "rich"],
  arms: ["kalman", "baseline", "active"],
  options: ACTIVE_OPTIONS,
  primaryFamily: "rich",
  primaryComparator: "baseline",
  primaryMetric: "totalNoFixS",
  successCriterion:
    "Paired scenario bootstrap 95% CI for active-minus-baseline mean totalNoFixS has upper bound below 0 in rich family. Original family and Kalman comparisons are secondary; disclose regressions. No tuning after audit.",
  durationS: 75,
  intervals: 1500,
  bootstrapReplicates: 4000,
  bootstrapSeed: 12345,
  unit: "scenario seed within each family; related families not pooled",
  censoring:
    "Initial acquisition censored at 75; never seen totalNoFixS 75. Final unreacquired losses retained, no complete-case dropping.",
  modelClaim:
    "Frozen ONNX weights, no retraining or recalibration; rich terrain and active own-loop observations are distribution shifts.",
  metricNotes:
    "Historical post-first-fix metric secondary can include endpoint 0.05 s; primary excludes final endpoint. Horizontal travel and actual selected-cover shielding reported separately.",
  created: new Date().toISOString(),
};
const target = process.argv[2] ?? "output/frozen-active";
mkdirSync(target, { recursive: true });
for (const p of paths) {
  const dest = `${target}/${p}`;
  mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  cpSync(p, dest);
}
symlinkSync(resolve("node_modules"), `${target}/node_modules`, "dir");
writeFileSync(
  `${target}/freeze.json`,
  JSON.stringify({ protocol, hashes }, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      target: resolve(target),
      files: paths.length,
      freezeSha256: createHash("sha256")
        .update(readFileSync(`${target}/freeze.json`))
        .digest("hex"),
      protocol,
    },
    null,
    2,
  ),
);
