# Collaborative drones: proposed next experiment

Status: design assessment only, 2026-11-15. The current authorized implementation improves one drone, camera readability and drone-view size. No multi-drone simulation or real-flight system is implemented here.

## Recommendation

Start with two simulated drones after establishing a measured single-drone planner baseline. Let one maintain a noisy sighting while the second searches a complementary viewpoint; when neither has a sighting, allocate different parts of the probability distribution instead of sending both toward the same peak. Roles should follow available observations and visibility predicted from the known map and each drone's pose, never hidden subject state or the simulator's visibility verdict.

This is a hypothesis to test, not a promised improvement. A second drone can provide another line of sight, but can also repeat the same search, share stale information, or alter the simulated subject's behavior.

## Multiple cameras on one drone

The user's camera reference suggests a separate experiment: a wide-angle search camera paired with a narrower zoom camera for examining a candidate sighting. These share nearly the same physical viewpoint, so zoom alone cannot reveal a subject behind an opaque trunk or boulder. A second drone can supply a substantially different viewing angle.

The current demo has one simulated sensing camera and one evaluation-only spectator pane. It does not simulate a dual-camera payload, stereo depth, thermal imaging, or camera-based obstacle avoidance. Its planner receives a known static map; that is not a demonstrated onboard mapping capability.

For a future wide/zoom experiment, explicitly model each camera's field of view, range and detection uncertainty, gimbal coupling, switching delay, and whether sensing is simultaneous. Zoom should trade field of view for detail, not create perfect measurements or see through cover. Give observations camera IDs and timestamps, account for correlated measurements, and change the model input contract before using both streams. Compare wide-only, wide/zoom, and two-drone coordination as distinct experiments with stated sensing and flight budgets. The supplied screenshot is a design reference, not verified hardware specifications.

## Architecture suitable for this repository

- A shared evidence log contains unique observation IDs, timestamps, drone ID, noisy measurement/uncertainty, sensor pose and missing-observation events. Process each evidence item once; distinguish unavailable communication from a sensor miss.
- A central simulation-only coordinator initially assigns complementary viewpoints by marginal expected coverage after the first drone's assignment. Penalize travel, overlap and incompatible routes. Start with centralized coordination to make behavior inspectable before considering distributed protocols.
- Keep each drone's dynamics, own pose, gimbal limits and sensor geometry separate. Add inter-drone separation and static-obstacle checks. Neither controller receives subject truth, cover choice or the simulator's visibility verdict.
- The current CNN contract encodes one drone pose and one sensor history. Do not imply it supports shared multi-drone evidence unchanged. Either evaluate a separate analytic shared-belief baseline or train/version/calibrate a model with an explicit multi-sensor contract.
- Do not multiply independently produced posteriors that already share a prior/history as if they were independent evidence. The observation log is a simpler starting point for avoiding duplication.
- Show both actual drone-camera feeds, their age/connection state, a shared belief map and each assigned viewpoint. Keep spectator-only cutaways out of both sensor views.

## Evaluation before claiming collaboration helps

Compare one improved drone, two independent drones, and two coordinated drones on the same predeclared scenario seeds. Report both equal wall-time and resource-aware costs: total flight distance, total drone-seconds, sensing/inference calls and communication volume. Retain failures, unresolved searches and paths that diverge because the subject reacts to different aircraft.

Include a single-drone run with a longer time budget matched on total drone-seconds. Before implementation evaluation, predeclare the primary comparison, required practical effect size, sample size, paired confidence interval and stopping rule. The primary coordination comparison should be coordinated versus independent two-drone search under the same budget, rather than attributing the benefit of a second aircraft entirely to coordination. Do not stop or add seeds based on whether the result becomes favorable.

Specify how the subject perceives multiple drones before tuning; quietly choosing whichever response makes coordination look best would invalidate the comparison. Include delayed/dropped messages, overlapping observations, one drone losing its view, prolonged occlusion and behavior changes beyond new random forest seeds. Freeze the system and protocol before a genuinely new final audit. Report region coverage with region area, reacquisition, censored search time and safety-limit violations.

## Research context and limits

The linked abstracts were checked directly on arXiv. These are limited research pointers, not a full-paper replication or evidence for this implementation.

[Hung, Hsu and Cheng, Image-Based Multi-UAV Tracking System in a Cluttered Environment (2021)](https://arxiv.org/abs/2109.07079) studies coupled camera-view, connection, occlusion and collision constraints and evaluates its controller in simulation. It supports treating those constraints jointly; it does not validate BeliefView or prove that this proposed design works.

[Wu et al., Exact Fusion and Coordinated Exploration in Multi-Robot Active Inference (2026 preprint)](https://arxiv.org/abs/2609.17384) distinguishes repeated counting of shared evidence from redundant action selection. Its guarantees depend on specific belief families and assumptions; they do not transfer automatically to this CNN's grid or a moving-subject search. The practical lesson here is to deduplicate evidence and evaluate complementary assignments explicitly.

This is a local synthetic research direction, not real-world validation.
