# Two-drone headless development

Local experimental implementation only. No team UI, final audit or collaboration performance claim has been released. The completed single-drone results and model are unchanged.

## Candidate 1 provenance

The pre-edit preservation baseline is a private local baseline manifest (not published; see [PUBLIC_SNAPSHOT.md](PUBLIC_SNAPSHOT.md)), SHA256 `566cd3645fde6d482fa7f7bee71dbd09879a8456648d475ba4e82897bfd79dd3`. Parent Codex independently verified it and approved the bounded headless plan after Claude's plan critique.

Candidate 1 is snapshotted in `demo3d/output/team-development-candidate1/source/`; its manifest records the exact source files at evaluation start. The evaluator preserves every full trajectory as a compressed JSON trace with SHA256, writes incremental raw results, refuses to overwrite prior evidence, and checks source hashes again at completion. The dataset is 32 development seeds, two separately analyzed terrain families, and four equal-resource two-drone arms. Reserved seeds remain prohibited by the scenario generator, irrespective of evaluator role flags.

**Metadata correction:** Candidate 1's evaluator accidentally labels capped initial acquisition as primary. This conflicts with the approved brief and is a labeling defect, not an endpoint change. The controlling primary endpoint remains total team no-observation time over 1500 intervals, including never-found episodes. The raw results retain both metrics. All subsequent analysis and power calculations must use `totalNoFixS` for the primary 3 s practical criterion; capped initial acquisition is secondary. The original incorrect metadata and its source snapshot are retained for traceability.

## What is implemented

Separate `src/team/` modules implement immutable source-tagged evidence, a coarse analytic grid, public-map viewpoint scoring, four comparison policies, and two physical sensor/controller states. No combined history enters the frozen single-sensor CNN. The public map is generated before hidden spawn and route selection, using fixed public waypoints for the rich generator. A fixed broad prior and a physically sensed 1 s common prefix ensure actual initial non-detection.

Each sensor produces noisy accepted observations every 0.05 s. Evidence is processed in 0.5 s batches; empty-view geometry comes from actual sensor poses. A missing packet is rejected, never interpreted as an empty view. Exact duplicates are idempotent; conflicting IDs are rejected. Same-time empty observations combine subcell masks using incremental union likelihood ratios, so joint and split deliveries give the same result.

The 32 x 32 grid uses 6 m cells clipped at the public world boundary, five symmetric spatial samples and two fixed hypothetical body heights. Measurements integrate a Gaussian over cell bounds. Negative evidence is a tempered heuristic with a public detection assumption, not calibrated probability. Diffusion, reflected boundary transport and a small public global escape term keep support available as the reactive subject moves. A fresh own observation controls each drone's follow status; a teammate's fix cannot manufacture an own-camera sighting.

The planner scores full supported grid mass, caches known-map visibility, routes a bounded shortlist of 14 positions and retains 24 routed views. Coordinated allocation discounts exact sampled overlap between two selected views. This bounded heuristic is not a globally optimal joint planner. A failed joint shortlist has an explicit independent-allocation fallback reason and count. Candidate 1's fallback overlap field is uncomputed but serialized as zero; it must not be used as evidence of zero duplicate coverage.

## Limits of this first screen

The shared emergency separation rule rolls both aircraft back to their previous valid poses and zeroes their velocities when their proposed swept paths breach 4 m. It is identical in all four arms. It can deadlock and is not dynamically feasible avoidance or a real-flight safety guarantee. Holds, actual displacement speed/acceleration and velocity-reset magnitudes are recorded. Inherited obstacle projections can also produce accelerations beyond the nominal controller limit.

Candidate 1 records behavior, sensor transcripts, own tracks and allocation traces. It does not record shared grids or calibration/NLL/region-area diagnostics; those secondary measures are unmeasured in this screen. Its scalar control radius must not be presented as a calibrated confidence region. Actual grid diagnostics and a versioned replay contract are required before any final audit or belief UI.

The subject reacts to delayed noisy cues from the nearest physical drone. This is a synthetic behavior approximation, not evidence of general human behavior. Subject trajectories can diverge between arms after policy actions diverge. Selected successes cannot substitute for paired aggregate results, and failed or never-found missions remain in every summary.

No existing UI copy or features are changed in this headless phase. The existing local single-drone demo remains available.

## Candidate 1 completed development results

All 64 world-family rows and 256 full episodes completed. All 52 source hashes matched at completion. These are development results, not untouched final evidence.

| Family | Independent | Fixed sector | Shared, independent allocation | Shared, coordinated allocation |
| --- | ---: | ---: | ---: | ---: |
| Original mean no-observation time | 45.04 s | 45.43 s | 43.16 s | 40.65 s |
| Rich mean no-observation time | 60.41 s | 57.34 s | 51.30 s | 51.41 s |

Rich coordinated minus independent was -8.99 s, with a descriptive paired development bootstrap interval [-14.13, -3.68] s. Original was -4.39 s [-10.08, 0.97]. Rich coordinated did not improve on shared evidence with independent allocation: +0.11 s [-6.14, 5.98]. The results support investigating evidence sharing; they do not establish a benefit from the marginal allocator.

Rich capped initial-finding means were 38.51 s independent and 29.53 s coordinated, with 12/32 and 5/32 never-found episodes. Shared-only was faster still at 26.02 s, with 1/32 never found. These are secondary outcomes, not a replacement primary endpoint.

Emergency holds remain a serious modeling limitation. Rich coordinated averaged 6.64 s of holds with a 30.5 s maximum; independent reached 44.5 s. Across the original family, a hold lasted 51.5 s. Recorded displacement-derived accelerations reached about 160 m/s² despite nominal 4 m/s² controller acceleration, confirming that rollback/projection is not physically feasible avoidance. All episodes had zero recorded subject water/solid penetrations and minimum pairwise swept separation at least 4 m; those facts do not eliminate the dynamics limitation.

The rich paired primary difference SD was 15.20 s. The predeclared normal-approximation power calculation for a 3 s effect and 80% power requires 202 pairs, rounded to 220, above the cap of 200. Candidate 1 therefore does not proceed to a final audit under this plan. The cap and practical target are not relaxed. A separately declared candidate 2 may address the measured controller deadlocks, using exactly the same correction across all arms; it must retain candidate 1 evidence and repeat the full development comparison before any decision about final evaluation or UI.

Raw results: `demo3d/ml/results/team_development_candidate1.json`. Corrected-primary analysis: `demo3d/ml/results/team_development_candidate1_analysis.json`. The original evaluator metadata error remains visible and explicitly corrected above.

## Candidate 2 declared mechanics correction

Candidate 2 changes the shared low-level avoidance stage identically across all four policies. It does not retune the estimator, planner scoring, subject, sensor noise, prior, seed sample or primary endpoint. Codex reviewed the concrete mechanism and Claude's mechanics critique before implementation. Candidate 1 remains intact.

The local stage predicts constant-velocity pair separation over 2 s, uses an 8 m soft buffer and a 4 m hard actual swept-path floor, and considers a bounded set of preferred, reduced-speed, braking and lateral-yield velocities. A has three times B's deviation penalty; B's side is fixed by the physical A-to-B axis at activation. The side stays locked at least 2 s and releases only after 1 s of forecast clearance beyond 10 m. Costs include preferred-velocity deviation, lost preferred-direction progress, forecast buffer deficit and lateral-yield deviation. These are named constants in the frozen source and protocol.

Persistent conflict is explicitly counted. Less than 0.5 m signed preferred-direction progress over 3 s, 6 s continuous conflict, or three activations within 15 s causes a counted deadlock/backoff. B receives a fixed 8 m public offset anchor away from A for 2 s; the anchor does not move each tick. The recurrence criterion was added after same-goal fixtures exposed repeated avoidance circles that reset the shorter progress window. Two aircraft cannot both occupy an identical point with 4 m separation; the test requires bounded arrival or an explicit unresolved-conflict count, not impossible simultaneous co-occupancy.

Intervention candidates limit velocity changes relative to stored controller velocity and validate their actual 3D swept segments against inflated known primitives and sampled terrain. With no forecast conflict, the inherited motion is returned exactly. Disabling the stage reproduces candidate 1 physical trajectories and observation metrics. This deliberately preserves inherited projection limitations outside intervention; actual displacement-derived acceleration is measured separately by inherited, avoidance and emergency-hold stage. These categories identify the current stage, not a complete causal decomposition of history. The inherited projection correction magnitude is also reconstructed from its documented position/velocity update equation.

A position already inside the requested inflated clearance margin can leave no feasible local candidate even when it is outside the physical obstacle. Such cases remain counted emergency holds; no geometry is silently relaxed. Mode and gimbal clocks continue while held, and the next physical observation uses the corrected actual position with those current camera angles.

Candidate 2 adds evaluation-only belief snapshots at 50 planning epochs per episode: grid probabilities, true-cell NLL, mean error and area/containment of the 95% model-mass region. Truth is used only to compute these diagnostics and never fed back to the filter or planner. A shared A/B posterior is the same state; summary analysis must collapse the duplicate and retain the scenario as its statistical unit. The region is not asserted to be calibrated confidence.

Additional boundary corrections reject seeds outside uint32 before checking reserved ranges, mark failed-joint overlap as `null`, and correctly label total no-observation time as primary. The unchanged ONNX files are included in candidate 2's manifest for provenance, though no ONNX inference drives this headless team mode.

Preflight: 30 team tests passed, including crossings, same-goal conflict reporting, stationary/inside-buffer cases, terrain-blocked hold, side lock, immutable backoff anchor, throwing hidden getters, reserve aliases, partial-evidence batching and unchanged public-transcript decisions. A complete 1501-frame stage-off replay of original development seed 220008 matched candidate 1 physical frames and metrics exactly. Codex separately reproduced a 20 s rich stage-off replay.

Candidate 2 development manifest SHA256: `5a4977316bd765295b283c33b4d464569c605f0074cdd824289c0273e3838691`. No reserved world or team UI is included.

## Candidate 2 completed results and disposition

All 64 world-family rows and 256 episodes completed with unchanged source hashes. The same 32 development pairs were reused for this declared second candidate; these are not fresh final results.

| Family | Independent | Fixed sector | Shared, independent allocation | Shared, coordinated allocation |
| --- | ---: | ---: | ---: | ---: |
| Original terrain mean no-observation time | 45.90 s | 45.20 s | 40.65 s | 40.00 s |
| Rich terrain mean no-observation time | 59.12 s | 56.31 s | 49.65 s | 52.27 s |

Here "original" refers to the original terrain generator with the new team subject wrapper, not the preserved single-drone experiment.

Rich coordinated minus independent was -6.85 s, with a descriptive paired development interval [-11.64, -2.00] s. Original was -5.89 s [-11.67, -0.41]. The rich paired SD of 13.97 s gives a power estimate of 171 pairs, rounded to 180 under the declared rule. Thus candidate 2 passes the statistical development screen for considering a final audit. That does not establish final performance.

The marginal allocator still has no demonstrated incremental benefit. On rich terrain it was 2.62 s worse than shared evidence with independent allocation, interval [-2.58, 7.66]. Its comparison with the cheap sector baseline was -4.04 s [-8.95, 0.92]. Rich capped initial-finding means were independent 37.76 s, sector 31.67 s, shared-only 26.23 s and coordinated 29.53 s; never-found counts were 11, 6, 1 and 5 of 32 respectively. This points toward evidence sharing as the useful direction and does not justify a sophisticated-allocation advantage claim.

Average hold time improved in several arms, but the mechanics readiness criterion is not met. Rich shared-only seed 220009 held for 47.95 s. Independent Codex inspection found 955 of its 959 held frames started inside the requested inflated clearance margin, while physical-obstacle projection at margin zero was zero. This is a clearance-recovery trap, not a demonstrated physical collision. Original coordinated seed 220031 still held for 40 s and reproduced exactly in two fresh processes. The local stage cannot recover from this condition because every candidate includes an already-invalid inflated start point. Fixing it requires an explicitly tested monotone clearance-recovery policy or a separately versioned consistent controller; relaxing physical geometry is not an acceptable shortcut.

All candidate 2 runs recorded zero subject water/solid penetrations and at least 4.54 m swept drone separation. Actual displacement speed reached 10.20 m/s in one rich independent episode, and acceleration reached 169.05 m/s² across arms. Maximum inherited projection corrections were about 0.39-0.41 m. Actual acceleration during avoidance-stage updates was near 4 m/s² in rich runs and reached 4.98 m/s² in original runs because stored velocity can differ from preceding actual displacement. Inherited and emergency stages retained much larger spikes. No global speed/acceleration or real-flight safety guarantee is made.

### Descriptive belief evidence

The following values first average correlated planning epochs within each episode, then average 32 scenario episodes. Shared A/B duplicate posteriors are collapsed. These are own-loop comparisons with different reactive subject trajectories, not calibration on a fixed shared transcript.

| Rich terrain arm | 95% model-mass containment | Mean region area | Mean grid-position error | Mean true-cell NLL |
| --- | ---: | ---: | ---: | ---: |
| Independent | 94.69% | 13,756 m² | 30.57 m | 4.72 |
| Fixed sector | 93.88% | 12,684 m² | 27.23 m | 4.54 |
| Shared, independent allocation | 94.63% | 6,817 m² | 16.56 m | 3.08 |
| Shared, coordinated allocation | 96.38% | 8,014 m² | 19.03 m | 3.16 |

Coverage near 95% comes with very large regions and must not be sold as precise localization. Coordinated subject paths differed from independent paths by a mean 20.10 m in rich terrain and 26.05 m in original terrain. The discrete-cell NLL and coarse grid are specific to this analytic model, not directly comparable with the earlier CNN metrics.

### Final local status

The new source-tagged ledger, analytic shared belief, public-map planner, four comparison arms and headless simulator are implemented and reviewable. Two complete development matrices, compressed physical/belief traces, source snapshots and corrected-primary analyses are retained. Independent Codex ran 153 tests successfully and verified deterministic fresh-process replay. Stage-off physical equivalence is recorded in `demo3d/ml/results/team_candidate2_stageoff.json`.

The two-drone mode is **not integrated into the visible demo**, and no untouched final seed was consumed. The serious controller recovery failure keeps this experiment headless. No additional variants, estimator tuning or performance promotion are made. The existing enlarged single-drone sensor view, richer terrain, spectator cutaway and all prior modes remain available unchanged on the local server.

A strong next increment should repair the measured motion/recovery contract first, then evaluate shared evidence against the cheap alternatives before spending on a team interface. Its presentation should expose source-tagged observations, what was ruled out, why each real sensor moved and when the system failed. More camera panes or a scripted handoff cannot substitute for that evidence.

Raw results and analyses:

- `demo3d/ml/results/team_development_candidate2.json`
- `demo3d/ml/results/team_development_candidate2_analysis.json`
- `demo3d/ml/results/team_development_candidate2_diagnostics.json`
- `demo3d/output/team-development-candidate2/manifest.json` and `traces/`

No UI feature, copy, disclosure, model artifact or pre-existing simulator source was deleted or rewritten during the team phase. All prior UI/simulation/model hashes were checked against the durable pre-team baseline and matched.
