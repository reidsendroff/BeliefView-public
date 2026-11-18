/** Preservation check against the immutable candidate1 raw traces. */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { simulateTeam } from "../src/team/runtime";
import { generateTeamScenario } from "../src/team/scenario";
const checks = [];
for (const [family, seed] of [
  ["original", 220031],
  ["rich", 220008],
] as const) {
  const path = `output/team-development-candidate1/traces/${family}-${seed}-coordinated.json.gz`;
  const old = JSON.parse(gunzipSync(readFileSync(path)).toString());
  const now = simulateTeam(
    generateTeamScenario(seed, seed + 5000, family),
    "coordinated",
    { avoidance: false },
  );
  const physical = (x: any) => ({
    frames: x.frames.map((f: any) => ({
      t: f.t,
      subject: f.subject,
      aircraft: f.aircraft,
      held: f.held,
    })),
    metrics: x.metrics,
  });
  const original = JSON.stringify(physical(old)),
    current = JSON.stringify(physical(now));
  if (original !== current) throw Error("Stage-off physical mismatch: " + path);
  checks.push({
    family,
    seed,
    frames: now.frames.length,
    stageOffExact: true,
    physicalSha256: createHash("sha256").update(current).digest("hex"),
    candidate1TraceSha256: createHash("sha256")
      .update(readFileSync(path))
      .digest("hex"),
  });
}
writeFileSync(
  "ml/results/team_candidate2_stageoff.json",
  JSON.stringify({ checks }, null, 2),
);
console.log(JSON.stringify(checks));
