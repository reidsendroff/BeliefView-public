# Active search, physical cover and two camera panes

Local implementation by Astra, with independent Codex plan and actual-diff review. No merge, deployment, publication, model fitting or recalibration. The previous uncommitted presentation work was preserved before this increment in a per-file hashed snapshot, now kept as a private local baseline (not published; see [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md)). Branch: `codex/astra-search-intelligence`.

## What changed

- `ActiveSearchGuidance` plans with the unchanged ONNX probability grid, full horizontal and vertical sensor FOV, public fixed posture hypotheses, actual empty sensor-footprint recency, a bounded exploratory prior, and route distance. A bounded Dijkstra search checks traversed segments and connects from the drone's actual altitude. Planning utility is separate from the raw model posterior. It can fall back to the existing Kalman viewpoint heuristic, and this is recorded for the UI.
- `policyRuntime` isolates orchestration from the historical simulator. The original learned arm remains selectable and reproduces the original simulator's complete frames and ML outputs exactly in a real-ONNX test. Kalman, frozen learned and active search use the same coarse start information and the same map within each terrain family.
- Rich terrain adds real boulders, fallen logs, bushes and raised leaf piles; a pond with a navigation-only shoreline barrier; mature thick trunks and saplings; irregular tree clusters; opaque low evergreen foliage; and seeded smooth relief. The same public map primitives drive sensor LOS, flight clearance and raster features. The height function drives terrain geometry, grounding and terrain LOS. Brown leaf litter and moss are surface colors only. Legacy decorative bushes are disabled in rich terrain.
- The rich subject is an explicit behavior variant: closer cover offsets, a crouched sensing point at 0.65 m, dry shoreline goals, and bounded iterative footprint correction with rollback. Actual posture is used only to simulate an observation, never supplied to guidance. A chosen cover object must itself shield the planned crouched position from the subject's delayed noisy drone estimate. Actual drone shielding is reported separately because that estimate can be wrong.
- The drone camera now occupies one of two separate 16:9 panes, half the scene width on desktop and full width on phones. The spectator pane retains Cinematic, Chase, Ground and manual Orbit. Render-only cutaway handles foreground trunks and physical cover as well as canopy. The sensor render stays opaque. Camera position now matches the simulator sensor origin rather than an old 0.25 m visual offset.

## Preservation and visible copy inventory

Original simulation, feature extractor, model bytes, training manifest, historical results and previous scenario samples remain unchanged. The original forest and frozen learned policy are selectable. Playback, scrub, event markers, speed controls, all four camera modes, manual Orbit, overlay toggles, truth/trail gating, model evidence, fallback, and replay links remain available. Controls use normal document flow around the two panes; narrow screens scroll to secondary views and diagnostics.

Intentional changes relative to the saved previous pass:

- The camera boundary caption now names both panes, retains "evaluation-only spectator camera (not available to the drone)" and "simulated drone camera", and explicitly says sensor cover stays opaque.
- "Canopy see-through" becomes "Spectator tree & cover cutaway" because trunks and new cover now participate. A live CUTAWAY label makes its state explicit.
- The active learned-policy line distinguishes the frozen baseline from active search v2 and moves to a dedicated strip above both panes. Fallback wording remains prominent and names Kalman.
- Historical coverage text now names the original policy/terrain and warns that the new variant is not calibrated. The original numeric source is preserved.
- Added terrain and learned-policy selectors, exact-static-map disclosure, rich-domain-shift disclosure, and active-planning explanation. The old baseline heuristic explanation remains visible for comparison.
- The old small inset and fixed overlapping panel positions are intentionally replaced with real document-flow panes and panels. No control or technical evidence section is deleted.
- Rich terrain deliberately replaces purely decorative rocks with real boulders and disables legacy decorative bushes; the original terrain retains its prior geometry and art.

## Model and inference boundaries

Model SHA256 remains `6c530b90a72e79629afec6d31b364f339a546bab42f3a39fc544418b6521e8f2`. No original training-source hash was rewritten to imply retraining. The versioned runtime and rich terrain are new runtime provenance, not a new training provenance. Existing map channels receive the new primitive geometry, but the model was not trained on this terrain or richer posture variant. Raw probability overlays remain unchanged; the planner's recency/exploration utility is not presented as calibrated probability or exact reacquisition chance.

All policies assume the exact static synthetic map is supplied in advance. The planner receives noisy sightings, its own pose, the map and model output. Throwing-getter tests exercise actual scoring without subject truth, hidden action/posture, visibility verdicts or selected cover. A commanded viewpoint never counts as an observed empty region. Navigation-only pond barriers are excluded from sensor/model/drone geometry. Multi-drone and wide/telephoto work are assessments only in `MULTI_DRONE_ASSESSMENT.md`; no second drone or second real sensor is implemented. The next proposed increment centers on source-tagged analytic team belief and equal-resource two-drone comparisons, not a claim of learned collaboration.

## Development selection and frozen audit protocol

Development used 32 world seeds 80000..80031 and subject seeds 85000..85031, each in original and rich families. The first candidate was retained in `active_development.json` with its exact matching source copy in `output/development-candidate-1`. An independently detected overlap correction defect was fixed before final selection. The corrected candidate and bounded ablations share the same corrected subject/map:

| Mean total no-observation seconds | Original | Rich |
| --- | ---: | ---: |
| Frozen learned baseline | 36.62 | 47.42 |
| Full active planner | 37.48 | 42.86 |
| Full FOV + routing, no novelty/exploration | 37.15 | 48.87 |
| Novelty + routing, no exploration | 41.22 | 46.28 |

These are development observations, not final evidence. The full candidate was selected; its rich paired mean difference was -4.56 s with a 95% bootstrap interval [-10.42, 1.07], still inconclusive. The original-family mean difference was +0.85 s. Raw corrected and ablation reports and matching source copy are retained.

The final candidate/protocol was frozen before any final worlds were generated. Freeze SHA256: `bc1117cf6cd3e269a1af1f48fecf647bb3bdd5d3996843a07b0007b47e4b1bb9`. The independent reviewer verified all 35 dependencies against both the immutable copied snapshot and workspace. The audit runs from that copied snapshot, checking hashes before and after execution.

Final reserve: 60 world/subject seed pairs starting 120000/125000, each run in both families under all three arms. Rich active-vs-frozen-learned is the single primary comparison; success requires the upper endpoint of the paired scenario bootstrap 95% interval to be below zero. Original-family and Kalman comparisons are secondary. Related families are analyzed separately, never pooled as 120 independent scenarios. Primary no-observation time includes all 1500 intervals from t0, so a never-found subject incurs 75 s. Initial acquisition is censored at 75 s, and final unreacquired losses remain in the report. Historical post-first-fix duration is secondary and retains its original endpoint convention. No tuning after final audit.

## Frozen final audit result

The predeclared primary success criterion was **not met**. The active planner stays experimental and selectable; the frozen learned baseline and Kalman default are preserved. No policy, terrain, model or evaluation code was tuned after these results.

| Mean no-observation seconds (75 s episodes) | Kalman | Frozen learned | Active | Active minus learned, 95% paired CI |
| --- | ---: | ---: | ---: | --- |
| Original, 60 seeds | 41.80 | 35.56 | 37.17 | +1.61 [-1.44, 4.47] |
| Rich, 60 seeds | 52.63 | 49.88 | 47.49 | -2.39 [-6.60, 1.65] |

Active beats Kalman in the secondary comparisons (original -4.63 s, CI [-8.62, -0.63]; rich -5.15 s, CI [-8.97, -1.33]), but that does not establish an improvement over the existing learned policy. It was worse than learned by more than 2 s in 23/60 original and 21/60 rich cases. There were 23 versus 17 final unreacquired losses in original active/learned, and 35 versus 36 in rich. All 360 runs obtained an initial fix at t0, so this audit provides reacquisition evidence, not evidence for difficult initial search.

Rich mean horizontal travel rose from 180.72 m to 188.50 m; original fell from 241.37 m to 220.36 m. Stall time changed only modestly (rich 3.80 to 3.71 s; original 4.26 to 3.82 s). The shorter original path is not proof of better search. Median subject-path divergence between learned and active was 26.77 m original and 25.49 m rich, reflecting the reactive subject; these are coupled own-loop comparisons, not a fixed subject counterfactual.

Raw-model episode-mean region coverage among episodes with prediction ticks was 94.96%/93.92% for original learned/active and 90.08%/91.00% for rich. Corresponding median episode region areas were 320/360 m² and 760/680 m² (conventional midpoint medians across episodes; the raw summary uses upper medians). These descriptive correlated-tick statistics are not a new calibration guarantee. Rich-model distribution shift remains visible.

All final runs had zero subject frames inside the pond. In the rich active arm, selected-cover HIDE seconds / seconds where that exact object's own geometry blocked the actual drone-to-torso ray were: boulder 48.60/25.05, bush 13.50/2.60, leaf pile 8.60/3.35, log 2.05/0.10. This proves all four types can participate in real occlusion, while also showing that a chosen hiding spot often fails against the actual moving drone. These are accumulated, correlated durations, not independent successful trials.

Raw report: `demo3d/ml/results/active_final_audit.json`, identical to the output in the frozen snapshot. All 35 dependency hashes passed at both evaluation start and completion. The final audit consumed its reserve once. Further improvement requires a new development cycle and a fresh untouched audit reserve.

## Verification and limitations

Current implementation tests: 123 passed across 11 files; production build passed. Tests include exact original-baseline equivalence, forbidden-getter scoring, actual-vs-commanded coverage bookkeeping, deterministic rich geometry, a terrain ridge LOS fixture, crouched-versus-standing low cover, genuine bush/log cover selection, clear route segments, water exclusion, overlapping-footprint collision correction and bounded visual silhouette approximation. Independent Codex diagnostics on 20 development Kalman rich episodes found zero water frames or physical-footprint penetrations after correction, and no non-HIDE stationary run longer than 3 s.

Definitive production browser report `intelligence_browser_final.json`: 74/74 checks passed, including all four rich/active camera modes playing through 75 s and stopping, and the active/fallback strip above both panes at all five sizes. The legacy browser smoke also passed 57/57 checks in headed Chrome. It covers six deterministic terrain/policy trajectories, missing and corrupt model fallback preserving rich terrain, five responsive viewport sizes down to 320x568, actual narrow-screen controls, manual Orbit drag, no runtime errors and no external app requests. At paused times 12/35/65, sensor PNG bytes are identical with cutaway on/off, while spectator image interiors differ after excluding the state label. Both versions are retained.

An intermediate strip relocation also failed four new viewport assertions: the status panel was detached before a document lookup, leaving the active line in its old location. Looking it up inside the detached dashboard fixed the issue; the failed report is retained. The software-renderer legacy smoke reached 54 passing checks before a navigation timeout during concurrent work; its stdout is retained, and the same 57 assertions subsequently passed in isolated headed Chrome.

The first browser preflight's t12 comparison failed because the screenshot helper scrolled the first crop beneath the fixed disclosure bar. Diagnostic ON1 had scrollY 148; OFF1/ON2/OFF2 had scrollY 0 and identical pixels. The failed report and all diagnostic images remain. The corrected isolation keeps scroll fixed and does not weaken the pixel equality assertion.

Geometry is intentionally synthetic: opaque spheres/cylinders, sampled terrain LOS, a single torso sensing point, and a planar pond. Inscribed subdivision-3 spheres and 24-sided rich cylinders have a small conservative silhouette discrepancy; randomized analytic-versus-render-mesh ray tests bound it. The subject may move through foliage but not solid footprints; the drone clears foliage. Higher viewpoints can see over low cover. No photorealism, real-drone safety, real sensing performance or multi-drone performance is claimed.

Independent development clearance diagnostic: applying the inherited eight-pass projection oracle again to recorded poses found eight frames across 20 rich Kalman runs with 2.7-5.2 cm residual against the requested inflated one-meter obstacle margin. These were margin shortfalls, not demonstrated physical obstacle penetrations. The frozen physics was not retuned on audit evidence; route checks and approximate controller enforcement do not establish exact flight safety.

Final headed GPU measurements at 1440x900: cold rich/active startup to a rendered t12 frame was 7.54 s in Cinematic and 2.64-2.67 s in Chase/Ground/Orbit. Cinematic's lazy spectator-rig precompute is the main extra cost. ONNX inference averaged 2.88-2.91 ms. Recent scheduling/frame intervals at the end of full motion had p95 values 13.4/13.8/14.3/15.3 ms for Cinematic/Chase/Ground/Orbit. These are machine-specific observations, not hardware-independent promises. Startup includes work needed at that replay time, not just inference. The final cutaway immediately removes newly obstructing foreground geometry, restores it gradually, and disables the spectator fade shader immediately when toggled off. All sensor pixel-invariance checks passed on this final render.

Final UI/source/bundle hashes: `demo3d/output/phase1-ui-build-hashes.json`. The complete incremental source diff against the saved previous presentation pass is in `demo3d/output/phase1-incremental.patch`. The local dev server remains at http://127.0.0.1:5174/; the new experiment is selected with `?terrain=rich&guidance=ml&policy=active&cam=chase`. No outward release occurred.
