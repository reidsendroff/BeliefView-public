# BeliefView search story: implementation and local evidence

This pass makes the existing search policy understandable and the forest visible. It does not change the trained model or make the drone search better than the existing baseline. Astra authored the implementation after independent Codex critique; Codex independently reviews the actual diff and evidence in the independent review (`ASTRA_SEARCH_STORY_REVIEW.md`, an internal record not published here; see [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md)).

> **Public snapshot note.** Several raw evidence artifacts linked below (`demo3d/ml/results/search_story_*.json` and the screenshots under `demo3d/output/playwright/`) are not included in this public snapshot, so those links do not resolve. The figures quoted in this report are the author's record of them and cannot be re-checked from this repository. See [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md).

## What changed

- A scene-first interface replaces three permanently expanded panels. Camera choices, active guidance/fallback, synthetic disclosure, spectator boundary, playback and sensor inset stay visible. Native details retain overlays, simulation diagnostics, model identity, calibration and safety copy.
- A render-only story explains the first sighting, missing fixes, descent route, lateral viewpoint search and confirmation. It uses a narrow projection of recorded observations/tracker/drone/viewpoint plus the existing learned distribution. It never reads subject truth or the simulator visibility verdict, and never claims an exact probability of reacquisition or a known reason for a missing fix.
- Three reproducible selections expose the original forest, development test-0, and retained development ML-worse test-46. URL replay retains scenario, camera mode, speed, time, truth setting and paused state. Policy changes preserve camera and speed. The UI explicitly explains that the subject reacts to the drone and trajectories can diverge.
- Instrumentation distinguishes navigation-to-first-render from model inference and app initialization. It includes camera work needed at the chosen replay time; a cold seek into a close shot exercises the lazy rig, while time-zero playback can defer that work. Render intervals are bounded rolling samples, with no telemetry transmission.

The compact CNN already has temporal observations, map geometry and decaying sensor-visible memory. The existing search heuristic already scores multiple possible locations by expected map-visible mass, travel cost and viewpoint hysteresis. No new architecture or planner was justified by the observed presentation weaknesses. Preserving the model and simulator also preserves their exact source provenance. No new training, model selection, calibration or final audit occurred.

## Preservation and copy accounting

The full before-edit inventory and acceptance criteria are in the plan (`ASTRA_SEARCH_STORY_PLAN.md`, an internal record not published here). No feature, route, simulator/model file, historical measurement, notebook or 2D experiment was deleted. Existing camera controls moved into a labeled navigation toolbar; the redundant visible "Camera" heading became its "Spectator camera" accessible label. The duplicate visible "Overlays" heading is supplied by the "Display overlays" details summary (its original node remains in the DOM). The subtitle was rewritten. Active-fallback punctuation changed from an em dash to a hyphen without changing meaning. All original safety disclaimers and technical labels remain. Model/overlay and flight/sensor details are now collapsible and scrollable; on very short phones, only a small part of the explanatory text fits at once.

## Model and historical evidence

- [Training notebook](../demo3d/ml/BeliefView3D_ml_training.ipynb), CPU/Colab workflow unchanged.
- [Manifest](../demo3d/public/models/beliefview3d-search-v1/manifest.json): model `beliefview3d-search-v1`, version `2.0.0`, SHA-256 `6c530b90a72e79629afec6d31b364f339a546bab42f3a39fc544418b6521e8f2`.
- [Historical RESULTS](../demo3d/ml/RESULTS.md) and all original result artifacts remain unchanged. Historical audit: median learned mean-position error 8.3 m versus Kalman 14.3 m; measured target-95% region coverage 94.8%, median area 976 m²; total unobserved time 33.85 versus 41.22 s; learned more than 2 s worse in 26/100 episodes. These are reference measurements, not new results.
- Existing ONNX parity tests reproduce eight saved training-model fixtures with maximum absolute per-cell probability error below 1e-5; exact source/schema/model hash tests pass. No training rerun is claimed. Same model identity is verified by browser hash checking and the tests.

## Selected replay measurements, not a new audit

[Reproducible evaluation source](../demo3d/tools/eval_presentation.ts) and raw results (`../demo3d/ml/results/search_story_examples.json`). Node ONNX wasm, same exported weights and simulator, both policies initialized from the same coarse area. Three examples were deliberately chosen for demonstration, including a known failure. Browser numerical trajectories can differ from Node; the browser's own reproducibility is checked separately.

| Selected example | Unobserved time, Kalman / learned | First loss, Kalman / learned | Reacquired losses, Kalman / learned | Subject path RMS divergence |
| --- | --- | --- | --- | --- |
| Original | 51.80 / 43.05 s | 11.30 / 7.25 s | 2/3 / 6/6 | 34.87 m |
| Another forest (test-0) | 39.85 / 39.55 s | 6.45 / 6.45 s | 3/3 / 2/2 | 2.63 m |
| Retained failure (test-46) | 33.35 / 67.85 s | 9.55 / 9.55 s | 3/3 / 1/2 | 37.22 m |

| Selected example, learned own closed-loop prediction ticks | Median mean-position error | Measured region coverage | Median region area |
| --- | --- | --- | --- |
| Original, 37 ticks | 7.92 m | 73.0% | 640 m² |
| Another forest, 29 ticks | 10.16 m | 100% | 1,168 m² |
| Retained failure, 66 ticks | 18.19 m | 100% | 4,352 m² |

The original replay's 73% coverage is a retained failure of the validation-calibrated region on that selected closed-loop example. A large region can cover the truth while guidance still fails, as test-46 shows. These are correlated ticks within three episodes; no population confidence interval or improvement claim follows. Unreacquired losses are censored at episode end and retained in the raw results. Comparisons are paired by initial scenario, not by a fixed subject path. Different forest seeds are within the same hand-written behavior family; they do not prove generalization to new behavior families. The earlier audit has now been inspected and is historical, not an untouched split available for future tuning.

## Verification

- Build and typecheck pass. 110 unit tests pass, including ONNX parity, exact provenance, inference leakage, weighted-distribution guidance, deterministic simulation, camera stabilization, and new narrow-interface throwing-proxy tests for the search explanation.
- Existing production browser smoke: 57/57 pass, including model load/hash, actual inference, meaningful guidance dependence, deterministic playback, missing/corrupt model fallback and preserved controls. New output is `../demo3d/ml/results/search_story_smoke.json`; the historical `browser_smoke.json` was not overwritten.
- Independent Codex unit rerun: 110/110 pass in 7.25 s. An earlier concurrent run had one 5 s timeout during browser contention; isolated rerun passed without weakening the test.
- Final headed Chrome 157.0.8103.79: 37/37 raw layout and full-motion checks (`../demo3d/ml/results/search_story_browser_final.json`), plus 59/59 raw controls/scenario checks (`../demo3d/ml/results/search_story_controls_final.json`). All four camera modes played the original learned replay to actual t=75 and stopped. Every preset/policy reproduced its digest on a second load; missing and corrupt models retained the selected challenge scenario in fallback. Copy-link success/denial, keyboard/native form behavior, pause, seek, restart, policy/scenario switches and truth gating passed.
- Layouts checked closed and fully expanded at 1440x900, 390x844, 390x667, 320x568 and 844x390: inset unobstructed, primary controls inside viewport, active/fallback line not covered. An initial fully expanded desktop inspector overlapped the inset; the height cap was corrected and all final checks passed. Final desktop (`../demo3d/output/playwright/search-story-final/layout-1440x900-open.png`) and short phone (`../demo3d/output/playwright/search-story-final/layout-390x667-open.png`) screenshots.
- No runtime page errors, unexpected console errors or external-origin requests in either final suite. The earlier software-WebGL attempt was stopped after revealing that fixed wall time is not a valid episode-completion test under the existing playback dt clamp. Its partial screenshots and explicitly non-authoritative author's finding summary (`../demo3d/ml/results/search_story_browser_partial.json`) remain; final claims rely on raw runner reports.

### Measured runtime on this machine

Raw `examples[]` in the final 37-check report store the viewport startup measurements; `motions[]` store full-episode samples and recent scheduling intervals.

| Measurement | Observed value |
| --- | --- |
| Cold desktop load into t=12, exercising lazy close-shot rig | 3,499.8 ms navigation to first rendered frame |
| Same desktop load: app initialization / model+simulation boot / scene constructor | 1,255.4 / 888.4 / 361.7 ms |
| Same desktop load: model load / inference p95 | 169.3 / 3.3 ms |
| t=12 first rendered frame across the five tested viewports | 3,204.8-3,499.8 ms |
| Time-zero first frame in the four motion runs | 1,115.6-1,170.2 ms; may defer close-shot rig work |
| Last <=300 frame scheduling intervals at full-episode end | p50 13.3 ms; p95 13.9-14.3 ms |

These are single-machine snapshots, not latency guarantees or GPU render-duration measurements. The recent interval window is bounded; early stalls may age out. All visible-tab gaps are now eligible, including gaps above one second. The t=12 startup measurement exercises camera work that a time-zero first-frame measurement does not necessarily include. Old 1.5 s browser-smoke precompute timing did not establish full camera readiness. The software-WebGL path was visibly slower and can stretch playback wall time because the preserved player clamps each time step to 0.1 s. Final copy clarifies deferred camera preparation; rebuilding after that wording-only change passed.

## Remaining limits

No real-world validation. The sensor, foliage, subject and motion remain synthetic approximations. The learned scorer is greedy, uses an approximate map-visible mass heuristic and may fall back per plan; the story does not invent per-choice diagnostics that were not recorded. Ground and Orbit can still be obscured by trunks. Camera behavior was preserved rather than redesigned. Short viewports require scrolling the explanations/details; the policy/fallback and primary controls remain visible. Screenshot sequences sample full rendered playback rather than proving every possible camera trajectory is comfortable.

Local-only work on `codex/astra-search-story`. No merge, deployment or publication. Development server: http://127.0.0.1:5174/ .
