/** Frozen development engineering matrix. No held-out performance or two-versus-three causal claim. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { generateThreeScenario } from "../src/team/threeScenario";
import { simulateThreeTeam } from "../src/team/threeRuntime";
import { THREE, THREE_VERSION } from "../src/team/threeConstants";
import { RECOVERY, EXTENDED_RECOVERY } from "../src/team/recovery";
import { CLEARANCE } from "../src/team/clearance";
import type { TeamArm } from "../src/team/types";
const arg = (key: string, fallback: string) => {
  const i = process.argv.indexOf("--" + key);
  return i < 0 ? fallback : process.argv[i + 1];
};
const indices = arg("indices", "0,1,7,9,13,16,17,31").split(",").map(Number);
const duration = Number(arg("duration", "300")),
  seed = Number(arg("seed", "220000")),
  subject = Number(arg("subject", "225000"));
const arms = arg("arms", "independent,sector,shared,coordinated").split(
  ",",
) as TeamArm[];
const out = arg("out", "ml/results/three_300_engineering.json"),
  snapshot = arg("snapshot", "output/three-300-engineering");
if (
  ![75, 180, 300].includes(duration) ||
  indices.length < 1 ||
  indices.length > 32 ||
  new Set(indices).size !== indices.length ||
  indices.some((i) => !Number.isInteger(i) || i < 0 || i > 31) ||
  !arms.length ||
  new Set(arms).size !== arms.length ||
  arms.some(
    (a) => !["independent", "sector", "shared", "coordinated"].includes(a),
  )
)
  throw Error("Invalid bounded engineering matrix");
if (existsSync(out) || existsSync(snapshot))
  throw Error("Preserve prior candidate evidence");
const walk = (p: string): string[] =>
  readdirSync(p, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
  );
const excluded = [
  "app.ts",
  "app.css",
  "template.ts",
  "replay.ts",
  "worker.ts",
  "simulatedGps.ts",
];
const files = [
  ...walk("src/sim"),
  ...walk("src/ml"),
  ...walk("src/team").filter((p) => !excluded.includes(p.split("/").at(-1)!)),
  ...walk("tests").filter((p) =>
    /^tests\/three\.(interfaces|motion|planner|runtime)\.test\.ts$/.test(p),
  ),
  "tools/eval_three.ts",
  "tools/check_three.py",
  "package.json",
  "package-lock.json",
];
const hash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes = Object.fromEntries(files.map((p) => [p, hash(p)]));
for (const p of files) {
  const dest = join(snapshot, "source", p.replace("../", "project/"));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(p, dest);
}
const protocol = {
  role: "Development engineering reliability; no reserved worlds and no final performance audit",
  candidate: THREE_VERSION,
  constants: THREE,
  recovery: RECOVERY,
  extendedRecovery: EXTENDED_RECOVERY,
  clearance: CLEARANCE,
  fleet: 3,
  indices,
  seed,
  subject,
  arms,
  families: ["original", "rich"],
  durationS: duration,
  dt: 0.05,
  runtimeOptions: { duration },
  engineeringGate: {
    minimumSweptSeparationM: 4,
    maximumConsecutiveForcedHoldS: 3,
    maximumCommandedStationaryS: 3,
    commandedSpeedThresholdMps: 0.1,
    stationaryDisplacementThresholdM: 1e-5,
    blockedEvents: 0,
    physicalInvalidFrames: 0,
    physicalInvalidSegments: 0,
    newMarginDeficits: 0,
    waterFrames: 0,
    subjectPenetrationFrames: 0,
    nonfiniteStates: 0,
    probabilityNormalizationTolerance: 1e-8,
  },
  primary:
    "Descriptive totalNoFixS over duration/dt intervals from t0, any accepted own sensor observation",
  secondary:
    "Initial acquisition censored at duration; individual confirmations and actual bearing diversity descriptive only",
  startupBudget: {
    worker180Ms: 20000,
    worker300Ms: 35000,
    serializedBytes: 100000000,
    scope: "This local machine; not mobile CPU guarantee",
  },
};
mkdirSync(snapshot, { recursive: true });
writeFileSync(
  join(snapshot, "manifest.json"),
  JSON.stringify({ protocol, hashes }, null, 2),
);
const rows: any[] = [];
const verify = () => {
  for (const [p, h] of Object.entries(hashes))
    if (hash(p) !== h) throw Error("Frozen source changed " + p);
};
const save = (complete: boolean) => {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      { protocol, sourceHashes: hashes, snapshot, complete, rows },
      null,
      2,
    ),
  );
};
for (const index of indices)
  for (const family of ["original", "rich"] as const) {
    const row: any = {
      index,
      family,
      worldSeed: seed + index,
      subjectSeed: subject + index,
      arms: {},
    };
    try {
      const generationStarted = performance.now();
      const scenario = generateThreeScenario(
        seed + index,
        subject + index,
        family,
      );
      const generationMs = performance.now() - generationStarted;
      row.generation = scenario.generation;
      row.generationMs = generationMs;
      for (const arm of arms) {
        try {
          const preparationStarted = performance.now();
          const timeline = simulateThreeTeam(scenario, arm, { duration }),
            serialized = JSON.stringify(timeline),
            d = timeline.diagnostics as any;
          const headlessPreparationMs =
            generationMs + performance.now() - preparationStarted;
          const tracePath = join(
            snapshot,
            "traces",
            `${family}-${seed + index}-${arm}.json.gz`,
          );
          mkdirSync(dirname(tracePath), { recursive: true });
          writeFileSync(tracePath, gzipSync(serialized));
          const engineeringPass =
            d.dronePhysicalInvalidFrames === 0 &&
            d.dronePhysicalInvalidSegments === 0 &&
            d.normalMarginDeficitIntroductions === 0 &&
            d.recovery.introducedDeficitViolations === 0 &&
            d.recovery.blockedEvents === 0 &&
            d.waterFrames === 0 &&
            d.subjectPenetrationFrames === 0 &&
            d.minSweptSeparationM >= 4 - 1e-8 &&
            Math.max(
              ...(Object.values(d.maxConsecutiveHoldSById) as number[]),
            ) <= 3;
          row.arms[arm] = {
            durationS: duration,
            headlessPreparationMs,
            serializedBytes: Buffer.byteLength(serialized),
            metrics: timeline.metrics,
            diagnostics: d,
            engineeringPass,
            tracePath,
            traceSha256: hash(tracePath),
          };
          console.log(
            JSON.stringify({
              index,
              family,
              arm,
              engineeringPass,
              wallMs: d.wallMs,
              bytes: row.arms[arm].serializedBytes,
              minsep: d.minSweptSeparationM,
              blocked: d.recovery.blockedEvents,
              maxHold: d.maxConsecutiveHoldSById,
            }),
          );
        } catch (error) {
          row.arms[arm] = { engineeringPass: false, error: String(error) };
          console.log(
            JSON.stringify({ index, family, arm, error: String(error) }),
          );
        }
        verify();
      }
    } catch (error) {
      row.generationError = String(error);
      console.log(
        JSON.stringify({ index, family, generationError: String(error) }),
      );
    }
    rows.push(row);
    save(false);
  }
verify();
save(true);
