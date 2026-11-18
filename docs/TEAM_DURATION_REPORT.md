# Longer team missions, teammate investigation and simulated GPS

Status: implementation and independent review complete; approved for the local demo. Numerical engineering, prefix verification and final rendered review passed. Implementation, 197 full-suite tests plus 3 focused Ground-framing tests, and production build pass. Local only; no merge, deployment or publication.

## Result

Team missions now simulate 180 seconds by default, with selectable 75-second reference and 300-second options. Changing duration computes a new actual mission and resets to 0 paused. It does not slow or loop a 75-second recording. Policy changes retain duration and replay position; copied links serialize both. Durationless team links intentionally adopt 180 seconds. The single-drone route and its main source remain unchanged.

Shared modes now investigate fresh teammate reports when the recipient lacks a recent own fix. The shared ledger supplies accepted noisy positions, source, time and sigma. Reports expire after 3 seconds without an update. A recipient's own accepted observation takes precedence; a teammate report never masquerades as its camera confirmation. A bounded known-map search chooses a distinct viewing position, using the existing motion limits and clearance/separation guards. Failed view selection, stale reports and bounded dwell return to ordinary search. Prompt dispatch is not a speed-cap increase or guaranteed fast arrival.

Simulated GPS labels show signed latitude/longitude for each drone's recorded pose and for noisy reported sightings. Local meters, source, age and sigma remain visible. The arbitrary origin is latitude 45.000000, longitude -93.000000; +x is east and +z is north, which is down on the preserved local belief grid. This small-area display conversion is not actual GPS hardware, terrain georeferencing or flight navigation. Six decimal places are formatting, not accuracy. Labels are outside the sensor viewports and have no inference or control input path.

Runtime `assist` and `extendedRecovery` options default false. Historical headless callers therefore retain the old policies. The UI explicitly enables both; assistance applies only to shared modes, while extended physical coordination applies equally to all four arms. Independent beliefs still do not exchange target observations. The 75-second UI option is a duration reference, not a claim that the new shared policy matches historical results.

## Baseline and review

Astra authored implementation. Claude critiqued the duration/assist plan, GPS display addendum and later long-run recovery repair before their respective edits. Codex independently reviews source, boundaries, actual traces, tests and rendered evidence. Plans: `TEAM_DURATION_PLAN.md`, `TEAM_SIMULATED_GPS_PLAN.md`, `TEAM_LONG_RECOVERY_PLAN.md` (internal records, not published here). Exact Claude inputs/reviews are preserved in `demo3d/output/team-duration-review-inputs/` (private, not published);

Durable pre-edit baseline: a private local baseline manifest (not published; see [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md)), SHA256 `6c81642cfe017eb56665567e3c7a3a00bcf0099d6a2c08e23329e2236b8a86bf`. It archives 167 source, test, tool, result, documentation and rendered files and hashes 12 historical trace manifests. Large immutable traces remain in place. Branch: `codex/astra-long-team-missions`.

No historical audit, model, controller snapshot or result was overwritten or relabeled. The single-drone main.ts, frozen single-drone physics, model weights and training provenance remain unchanged. Final numerical and UI/build manifests are separate so display-only GPS changes do not relabel numerical evidence.

## Failed first long-run candidate and scoped repair

The first 64-run, 300-second matrix failed five development episodes. These failures remain in `ml/results/team_duration_300_engineering.json`, with source snapshot `output/team-duration-300-engineering/manifest.json` (SHA256 `1b9117e1e34eb4e78cf52f5dbdca36cd5045e4262cb004fb097f563b7185db16`). The independent complete-trace gate is `ml/results/team_duration_300_independent_gate.json`.

One case, original 220009/shared at 277.4 seconds, had a physically valid, zero-deficit pose with valid 1 m escape steps, but the old contact search considered only 2 m and 4 m steps. Repeated failure exhausted retries and caused a 22.6-second hold. Four other cases assigned active local detour waypoints less than 4 m apart, making simultaneous arrival impossible under the correct hard separation guard. They were original 220009/coordinated, original 220013/coordinated, rich 220013/independent and original 220017/coordinated.

The original 220009 assist-disabled 300-second control runs did not fail: new assist trajectories exposed that existing mechanics gap. The independent rich 220013 failure demonstrates a separate latent long-horizon problem. Neither blanket attribution to assistance nor a claim that all earlier 75-second runs were unreliable is supported.

Version 2 preserves the old 2 m/4 m selection whenever feasible, adding a bounded short-step fallback only when it fails. Terminal net progress must exceed the existing 0.5 m progress requirement plus 0.15 m arrival radius. Live detour waypoints are reserved with 4.5 m spacing; existing reservations take priority, and simultaneous requests use stable drone IDs. Blocked or held peers also constrain full new segments around their actual positions. Stale blocked paths do not remain reserved. Reservation-only waiting has a non-resetting 3-second clock and does not burn geometry retry attempts; expiry is still a failed blocked state, not an exemption from the gate.

The actual swept 4 m separation, physical solids, desired margins, motion commands, 12-second detour cap and 3-second stationary cap remain unchanged. Reservations are a local physical coordination heuristic, not a global path proof.

All five failed cases plus the default mission passed targeted actual 300-second reruns. In the recorded pocket, the drone starts at the exact old pose and uses one short fallback. Independent trace inspection found it 0.528 m away at 278 seconds, 6.004 m at 285 seconds and 30.871 m at 300 seconds. It does not oscillate indefinitely in the pocket. Raw targeted evidence is `output/team-long-recovery-v2-targeted/`.

## Final verification

The full suite passed 197/197 tests across 19 files, including valid-endpoint/interior-crossing geometry, stale reservations, bounded wait, source ordering, malformed packets, own-fix precedence, finite timeline timestamps, duration bounds and GPS truth isolation. Production TypeScript/Vite build passed. The final pre-matrix numerical manifest is `output/team-duration-v2-prefreeze/manifest.json`, SHA256 `17cfb30cfa763d54b1748cd79e1d70eb464e3b20db9b153cd4000ee7fc0190db`. Pre-Ground UI/source/build manifest is `output/team-duration-v2-ui-build.json`, SHA256 `9bb0aa7b98a6a7d4e82af9b3e569711e985cf9426fcb2933d1946d6feaff3b94`. Final Ground/caption source/build manifest is `output/team-duration-final-ui-build.json`, SHA256 `a4ea66e98878b961fed52640b9d5903a12ac7440d742b31d5609f47025e41257`; all 58 frozen numerical hashes remain unchanged.

Final protocol: the same 64 actual 300-second runs, using eight predeclared development missions, two terrain families and four arms; eight actual 180-second default-mission runs; independent 75/180/300 prefix checks, excluding terminal-only bookkeeping while separately checking physical/sensor endpoints. The gate requires no physical-invalid motion, new margin deficits, blocked events, subject penetration, water entry or nonfinite state; normalized model mass; swept separation at least 4 m; and no forced or commanded-stationary window above 3 seconds. Never-finding remains a retained search outcome. This is repair on development cases, not untouched validation or a performance audit. Final reserved worlds remain unused.

The GPS/UI implementation already passed 86 author control checks at an explicit 75-second horizon and 57 legacy single-drone smoke checks. Those artifacts are `ml/results/team_duration_controls_v1.json` and `ml/results/team_duration_legacy.json`. Legacy real ONNX inference, provenance and missing/corrupt-model fallback remain intact. They establish UI/legacy preservation, not final v2 numerical reliability.

Codex's pre-repair GPS browser checks independently recomputed drone and noisy-report coordinates, verified label/sensor isolation and 320-pixel layout, and completed actual 300-second playback. Its first motion attempt had a stale browser read and is explicitly retained as invalid for full-motion evidence. Final v2 browser evidence and clean startup measurements are recorded separately below when complete.

All 64 five-minute runs and all 8 three-minute runs passed the complete engineering gate. Codex independently verified every raw trace/hash and recomputed motion, hold, separation, metric and normalized-mass checks. Both matrices had maximum consecutive forced holds and commanded-stationary windows of 0.05 s. Minimum swept separation was 4.000047764 m at 300 seconds and 4.229031106 m at 180 seconds. Reports: `ml/results/team_duration_v2_{300,180}_engineering.json` and corresponding `_independent_gate.json`.

The separate reviewer generated eight fresh 75-second timelines and verified all 24 horizon-prefix comparisons across 75/180/300 seconds. Complete pre-endpoint frames, decisions and beliefs match exactly; terminal physical/sensor state matches while the horizon-only replan latch is excluded. Artifact: `output/team-duration-v2-independent-prefix/comparison.json`. Four historical-default 75-second arms also match prior v5 full frames, decisions, beliefs and metrics exactly with both new options disabled.

In one selected development mission17, Drone B accepts a fix at 9.9 s and Drone A begins investigating at 10.0 s. A's first own observation occurs at 39.4 s versus 51.6 s in a same-version, extended-recovery-enabled assist-off control. This example does not establish general superiority: A travels less in the next 10 s (27.64 m versus 30.11 m), and is slightly farther from the fixed original report (42.88 m versus 41.01 m). Its purpose is a distinct viewing angle, not maximum direct approach. Reactive subject trajectories can diverge. Raw controls and metrics: `ml/results/team_duration_v2_assist_example.json`.

Final v2 independent production browser passed 21 checks, including actual 300-second playback at 4x in 75.244 measured wall seconds, ending paused at 300; GPS recomputation, all four late camera modes, pixel isolation, 320px layout and no runtime/external/ONNX requests. Artifact: `ml/results/team_duration_v2_independent_browser.json`. These startup timings were contended and are not budget evidence. A subsequent render-only Ground correction and final clean startup/fault checks are documented below.

## Ground spectator correction

Visual review caught a reproducible Ground view aimed down at pond water. Instrumentation showed the camera above and outside the pond; the old 25% blend toward a distant drone placed the look target only 1.31 m from the camera. After separate Claude plan critique, a default-false Stage option makes team Ground aim at the subject torso while preserving camera position, terrain handling, all other camera branches and both sensor cameras. The exact t10 fixture now has a roughly 15.55 m aim distance and centers the subject in the image. No speculative water/physics change was added.

The 54-check Ground browser artifact (`ml/results/team_ground_browser.json`) samples six times through 300 seconds and both focus choices in all four modes. Directly toggling the new option preserves both actual sensor pixel buffers and the canonical numerical digest. Before/after screenshots are in `output/playwright/team-ground-final/`. This artifact preceded the final Orbit caption correction; final copy checks are separate. Three focused tests pass and the final legacy single-drone smoke rerun passes 57/57 (`ml/results/team_duration_ground_legacy.json`).

Ground now says 'Evaluation only / Ground frames the subject'. Orbit says 'Evaluation only / manual Orbit'. Chase/Cinematic retain selected Drone A/B captions. The added note reads: 'Chase and Cinematic use the selected drone. Ground frames the subject; Orbit is manually controlled.' This corrects the inherited implication that Orbit followed the selected drone without changing Orbit behavior. The plan and touched-file baseline are `TEAM_GROUND_FRAMING_PLAN.md` and `demo3d/output/team-ground-framing-baseline/` (internal records, not published here).

## Clean local startup and final controls

After all numerical/independent CPU work and other browser sessions finished, the final production build passed 33/33 author duration/fault checks: `ml/results/team_duration_browser.json`. Default 180 computes 3,601 frames in 4.560 s and renders its first frame in 5.559 s, with 23.08 MB serialized payload. Actual 300 computes 6,001 frames in 7.556 s and first renders the requested t150 Ground frame in 8.722 s, with 38.01 MB payload. A second 180 reload measured 4.475 s compute/5.420 s first frame. These satisfy the declared local 15 s/30 s worker and 100 MB payload budgets. Lazy camera work after the first frame is not included in a claim that every later frame meets a deadline.

The suite independently exercises durationless default, late seek/end/restart, reachable duration controls at 320x568, policy/time preservation, copied/reloaded URL determinism, malformed wrong-horizon worker rejection before rendering, cancellation/retry, no 'aircraft' wording in rendered/aria/option text, no errors/external/model requests, and both sensor pixel invariance under cutaway/truth/GPS label toggles at 150/290 s.

Final Codex production review passed 24/24 checks after the Ground/caption correction (`ml/results/team_ground_final_independent_browser.json`). Actual full 300-second Ground playback at 4x completed in 75.254 measured wall seconds and ended paused at 300. The reviewer inspected final endpoint and handoff images, live mode captions, GPS provenance, both sensor isolation checks and 320px layout. Independent disposition: approved for local demo, per `TEAM_DURATION_REVIEW.md` (an internal record, not published here). No merge, deployment or publication is included.

## Intentional copy and control changes

No feature or disclosure removed. Added a team duration select; dynamic loading, counter and never-found duration; active duration/assist label; source-aware investigation status; simulated GPS lines and method explanation. User-requested terminology changes all visible team "aircraft" wording to "drone", including headline, options, loading/status, ledger and aria text. Internal type/data names and historical wording remain unchanged. The cloned legacy disclosure remains verbatim.

The method now distinguishes routine 1.5-second planning from earlier fresh-report dispatch, and identifies the common physical reservation layer across independent/shared arms. Waiting is labeled explicitly. All four spectator modes, A/B focus, actual 16:9 sensor views, cutaway/truth isolation, replay speeds, restart, scrub, copy link, mobile scroll/playback rail, cancellation/retry/error, fingerprint and numeric-digest guards remain. Returning to single mode removes team duration. Invalid or unsupported duration inputs choose the bounded 180-second default.

## Limits

No search-superiority or calibrated-confidence claim is introduced. The 300-second matrix records maximum actual 3D speed 9.04 m/s and acceleration 173.31 m/s². Inherited collision projection and holds can produce acceleration discontinuities; this remains a synthetic point-position model, not a validated airframe controller. The map is supplied exactly, observations are simulated, and some missions never find the subject. Simulated GPS is display-only. A source report can be unavailable, stale or lack a feasible sampled support viewpoint. Local compute and payload costs are measured on this machine, not promised for mobile hardware.

## Evidence commands and artifacts

- Full suite: `npm test -- --maxWorkers=1`, 197/197, log `output/team-duration-v2-unit.log`; focused render fixture: `npx vitest run tests/team.groundFraming.test.ts`, 3/3, log `output/team-ground-framing-unit.log`.
- Final production build: `npm run build`, log `output/team-ground-framing-final-build.log`.
- Numerical engineering: `npx tsx tools/eval_team_duration.ts` with the frozen protocol/manifest in each result; 300-second and explicit `--indices 16 --duration 180` runs retain source snapshots and compressed full traces. Independent gates and prefixes are separate artifacts, not author assertions.
- Final author duration checks: `node tests/browser/team.duration.mjs`, 33/33, log `output/team-duration-final-browser.log`.
- Legacy smoke: `BV_HEADED=1 BV_REPORT_PATH=ml/results/team_duration_ground_legacy.json BV_SHOT_DIR=output/playwright/team-duration-ground-legacy node tests/browser/smoke.mjs`, 57/57. Historical default report was not overwritten.
- Ground instrumented script is preserved in `output/team-duration-review-inputs/bv-ground-final-pre-orbit-caption.mjs`; raw 54 checks and image pairs retain their pre-caption scope.
- Final `git diff --check` passes. No merge, deployment or live-production verification occurred. Local dev server remains available on port 5174.
