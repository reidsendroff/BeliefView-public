/** First bounded engineering probe. Preserves all failed cases and exact numerical source. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { simulateThreeTeam } from "../src/team/threeRuntime";
import { generateThreeScenario } from "../src/team/threeScenario";
const out = process.env.BV_PROBE_OUT ?? "output/three-drone-probe-v1";
const duration = Number(process.env.BV_PROBE_DURATION ?? 75);
const motion = process.env.BV_PROBE_MOTION
  ? JSON.parse(process.env.BV_PROBE_MOTION)
  : undefined;
if (existsSync(out)) throw Error("Preserve previous probe");
mkdirSync(out, { recursive: true });
const walk = (p: string): string[] =>
  readdirSync(p, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
  );
const files = [
  ...walk("src/sim"),
  ...walk("src/ml"),
  ...walk("src/team").filter(
    (p) =>
      ![
        "app.ts",
        "app.css",
        "template.ts",
        "replay.ts",
        "worker.ts",
        "simulatedGps.ts",
      ].some((s) => p.endsWith("/" + s)),
  ),
  ...walk("tests").filter((p) => p.includes("three.") && p.endsWith(".ts")),
  "package.json",
  "package-lock.json",
  "tools/probe_three.ts",
  "../docs/THREE_COVER_API.md",
].filter((p) => !p.endsWith(".json.gz"));
const sha = (p: string) =>
    createHash("sha256").update(readFileSync(p)).digest("hex"),
  hashes = Object.fromEntries(files.map((p) => [p, sha(p)]));
for (const p of files) {
  const dest = join(out, "source", p.replace(/^\.\.\//, "project/"));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(p, dest);
}
writeFileSync(
  out + "/manifest.json",
  JSON.stringify(
    { role: "Bounded development probe, not audit", duration, motion, hashes },
    null,
    2,
  ),
);
const cases: {
  family: "original" | "rich";
  arm: "independent" | "sector" | "shared" | "coordinated";
  index: number;
}[] = process.env.BV_PROBE_CASES
  ? JSON.parse(process.env.BV_PROBE_CASES)
  : (["original", "rich"].flatMap((family) =>
      ["shared", "coordinated"].map((arm) => ({ family, arm, index: 16 })),
    ) as any);
if (
  !cases.length ||
  cases.some(
    (c) =>
      !["original", "rich"].includes(c.family) ||
      !["independent", "sector", "shared", "coordinated"].includes(c.arm) ||
      !Number.isInteger(c.index) ||
      c.index < 0 ||
      c.index > 31,
  )
)
  throw Error("Invalid bounded probe cases");
const rows: any[] = [];
for (const { family, arm, index } of cases) {
  try {
    const timeline = simulateThreeTeam(
      generateThreeScenario(220000 + index, 225000 + index, family),
      arm,
      { duration, motion },
    );
    const trace = out + "/" + family + "-" + index + "-" + arm + ".json.gz";
    writeFileSync(trace, gzipSync(JSON.stringify(timeline)));
    const d = timeline.diagnostics as any;
    const dronePass =
      d.dronePhysicalInvalidFrames === 0 &&
      d.dronePhysicalInvalidSegments === 0 &&
      d.normalMarginDeficitIntroductions === 0 &&
      d.recovery.blockedEvents === 0 &&
      d.minSweptSeparationM >= 4 - 1e-8 &&
      Math.max(...(Object.values(d.maxConsecutiveHoldSById) as number[])) <= 3;
    const subjectPass =
      d.subjectPenetrationFrames === 0 &&
      d.waterFrames === 0 &&
      d.maxSubjectRouteBlockedS <= 3.05 &&
      d.maxSubjectNoProgressS <= 3.05 &&
      d.maxSubjectLoopRunS < 16;
    const pass = dronePass && subjectPass;
    const row = {
      dronePass,
      subjectPass,
      family,
      arm,
      index,
      pass,
      trace,
      traceSha256: sha(trace),
      metrics: timeline.metrics,
      diagnostics: d,
      viewTaskFrames: timeline.frames.filter((f) => f.viewTasks.length).length,
    };
    rows.push(row);
    console.log(
      JSON.stringify({
        family,
        arm,
        pass,
        wallMs: d.wallMs,
        initial: timeline.metrics.initialAcquisitionS,
        nofix: timeline.metrics.totalNoFixS,
        minsep: d.minSweptSeparationM,
        blocked: d.recovery.blockedEvents,
        maxHold: d.maxConsecutiveHoldSById,
        tasks: row.viewTaskFrames,
      }),
    );
  } catch (error) {
    rows.push({ family, arm, pass: false, error: String(error) });
    console.log(JSON.stringify(rows.at(-1)));
  }
  writeFileSync(
    out + "/results.json",
    JSON.stringify({ complete: false, hashes, rows }, null, 2),
  );
}
for (const [p, h] of Object.entries(hashes))
  if (sha(p) !== h) throw Error("Frozen source changed " + p);
writeFileSync(
  out + "/results.json",
  JSON.stringify({ complete: true, hashes, rows }, null, 2),
);
