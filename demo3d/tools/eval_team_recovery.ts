/** Development only. Reserve worlds are rejected inside scenario generation regardless of CLI flags. */
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
import { CLEARANCE } from "../src/team/clearance";
import { RECOVERY } from "../src/team/recovery";
import { AVOIDANCE } from "../src/team/avoidance";
import { generateTeamScenario } from "../src/team/scenario";
import { simulateTeam } from "../src/team/runtime";
import type { TeamArm } from "../src/team/types";
const arg = (key: string, fallback: string) => {
  const i = process.argv.indexOf("--" + key);
  return i < 0 ? fallback : process.argv[i + 1];
};
const count = Number(arg("count", "32")),
  seed = Number(arg("seed", "220000")),
  subject = Number(arg("subject", "225000"));
const out = arg("out", "ml/results/team_recovery_v5_engineering.json");
const snapshot = arg("snapshot", "output/team-recovery-v5-engineering");
const families = ["original", "rich"] as const;
const arms: TeamArm[] = ["independent", "sector", "shared", "coordinated"];
if (!Number.isInteger(count) || count < 1 || count > 32)
  throw Error("Bounded development count must be 1..32");
if (existsSync(join(snapshot, "manifest.json")) || existsSync(out))
  throw Error("Refusing to overwrite prior candidate evidence");
const walk = (p: string): string[] =>
  readdirSync(p, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
  );
const files = [
  ...walk("src"),
  "tools/eval_team_recovery.ts",
  ...walk("tests").filter((p) => p.includes("team")),
  "package.json",
  "package-lock.json",
  "public/models/beliefview3d-search-v1/manifest.json",
  "public/models/beliefview3d-search-v1/model.onnx",
  "tools/check_team_engineering.py",
];
const hash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes = Object.fromEntries(files.map((p) => [p, hash(p)]));
for (const p of files) {
  const dest = join(snapshot, "source", p.replace("../", "parent/"));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(p, dest);
}
const protocol = {
  role: "engineering regression, not final performance audit",
  candidate: "team-recovery-v5.1-explicit-vec3-boundary",
  recovery: RECOVERY,
  clearance: CLEARANCE,
  engineeringGate: {
    maxConsecutiveHoldS: 3,
    physicalInvalidFrames: 0,
    physicalInvalidSegments: 0,
    introducedRecoveryDeficits: 0,
    blockedEvents: 0,
    normalMarginDeficitIntroductions: 0,
    minimumSweptSeparationM: 4,
    commandedStationarySpeedThresholdMps: 0.1,
    stationaryDisplacementThresholdM: 1e-5,
    maximumCommandedStationaryRunS: 3,
    waterFrames: 0,
    subjectPenetrationFrames: 0,
    nonfiniteStates: 0,
    probabilityNormalizationTolerance: 1e-8,
  },
  avoidance: AVOIDANCE,
  count,
  seed,
  subject,
  families,
  arms,
  durationS: 75,
  dt: 0.05,
  primary:
    "totalNoFixS over 1500 intervals; any accepted sensor observation counts",
  secondary: "initialAcquisitionS, never acquired penalized at 75 s",
};
writeFileSync(
  join(snapshot, "manifest.json"),
  JSON.stringify({ protocol, hashes }, null, 2),
);
const rows: any[] = [];
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
function summarize() {
  return Object.fromEntries(
    families.map((f) => {
      const r = rows.filter((x) => x.family === f);
      return [
        f,
        Object.fromEntries(
          arms.map((a) => [
            a,
            {
              n: r.length,
              initialAcquisitionS: mean(
                r.map((x) => x.arms[a].metrics.initialAcquisitionS),
              ),
              acquired: r.filter((x) => x.arms[a].metrics.initialAcquired)
                .length,
              totalNoFixS: mean(r.map((x) => x.arms[a].metrics.totalNoFixS)),
              holdSeconds: mean(
                r.map((x) => x.arms[a].diagnostics.holdSeconds),
              ),
              horizontalTravelM: mean(
                r.map((x) => x.arms[a].diagnostics.horizontalTravelM),
              ),
              wallMs: mean(r.map((x) => x.arms[a].diagnostics.wallMs)),
            },
          ]),
        ),
      ];
    }),
  );
}
function save(complete: boolean) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        protocol,
        sourceHashes: hashes,
        snapshot,
        complete,
        summary: summarize(),
        rows,
      },
      null,
      2,
    ),
  );
}
for (let i = 0; i < count; i++)
  for (const family of families) {
    const scenario = generateTeamScenario(seed + i, subject + i, family),
      results: any = {};
    for (const arm of arms) {
      const timeline = simulateTeam(scenario, arm, {
        avoidance: true,
        recovery: true,
      });
      const tracePath = join(
        snapshot,
        "traces",
        `${family}-${seed + i}-${arm}.json.gz`,
      );
      mkdirSync(dirname(tracePath), { recursive: true });
      writeFileSync(tracePath, gzipSync(JSON.stringify(timeline)));
      results[arm] = {
        metrics: timeline.metrics,
        diagnostics: timeline.diagnostics,
        engineeringPass:
          timeline.diagnostics.normalMarginDeficitIntroductions === 0 &&
          Number(timeline.diagnostics.minSweptSeparationM) >= 4 - 1e-6 &&
          timeline.diagnostics.waterFrames === 0 &&
          timeline.diagnostics.subjectPenetrationFrames === 0 &&
          timeline.diagnostics.dronePhysicalInvalidFrames === 0 &&
          timeline.diagnostics.dronePhysicalInvalidSegments === 0 &&
          (timeline.diagnostics.recovery as any).introducedDeficitViolations ===
            0 &&
          (timeline.diagnostics.recovery as any).blockedEvents === 0 &&
          Math.max(
            ...Object.values(
              timeline.diagnostics.maxConsecutiveHoldSById as Record<
                string,
                number
              >,
            ),
          ) <= 3,
        tracePath,
        traceSha256: hash(tracePath),
      };
    }
    rows.push({
      family,
      worldSeed: seed + i,
      subjectSeed: subject + i,
      generation: scenario.generation,
      arms: results,
    });
    save(false);
    console.log(
      JSON.stringify({
        completed: rows.length,
        total: count * 2,
        family,
        worldSeed: seed + i,
        initial: Object.fromEntries(
          arms.map((a) => [a, results[a].metrics.initialAcquisitionS]),
        ),
        holdS: Object.fromEntries(
          arms.map((a) => [a, results[a].diagnostics.holdSeconds]),
        ),
      }),
    );
  }
for (const [p, h] of Object.entries(hashes))
  if (hash(p) !== h) throw Error("Source changed during evaluation: " + p);
save(true);
console.log(JSON.stringify({ complete: true, out, summary: summarize() }));
