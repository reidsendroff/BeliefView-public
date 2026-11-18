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
const out = arg("out", "ml/results/team_development_candidate2.json");
const snapshot = arg("snapshot", "output/team-development-candidate2");
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
  "tools/eval_team.ts",
  ...walk("tests").filter((p) => p.includes("team")),
  "package.json",
  "package-lock.json",
  "public/models/beliefview3d-search-v1/manifest.json",
  "public/models/beliefview3d-search-v1/model.onnx",
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
  role: "development",
  candidate: 2,
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
      const timeline = simulateTeam(scenario, arm, { avoidance: true });
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
