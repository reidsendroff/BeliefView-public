# Related work reviewed for BeliefView

Reviewed by Codex on 2026-11-14 from the linked primary papers. These works motivate questions and limitations; none validates BeliefView's synthetic numbers or demonstrates drone tracking.

1. Yongbo Chen and Hanna Kurniawati, ["POMDP Planning for Object Search in Partially Unknown Environment" (NeurIPS 2023)](https://proceedings.neurips.cc/paper_files/paper/2023/file/a6d7226db2ff3643d8624624e3859c19-Paper-Conference.pdf). A Fetch mobile manipulator searches for target objects occluded among indoor furniture and objects in a partially known 3D environment. It uses a growing-state POMDP and GPOMCP, with candidate base/head/lift actions and possible removal of occluders. Four Gazebo object-search scenarios have 20 trials each. BeliefView shares the broad idea of acting on uncertain target location to improve visibility. Its subject moves through a known 2D map, its observer does not manipulate cover, and its planner is a small greedy rollout rather than GPOMCP. The paper is related work, not a benchmark result or drone-tracking demonstration.

2. Francesco Taioli et al., ["Unsupervised Active Visual Search with Monte Carlo Planning under Uncertain Detections" (2023)](https://arxiv.org/abs/2303.03155). Indoor object search uses a 2D floor map, probabilistic detections, belief updates, and POMCP-style planning with an RGB-D detector. It is especially relevant to treating missed detections as uncertain evidence rather than proof of absence. Its real detector, false-positive handling, and online POMDP planning differ from BeliefView's synthetic no-false-positive sensor and greedy planner.

3. Javier Velez et al., ["Active Exploration for Robust Object Detection" (IJCAI 2011)](https://ijcai.org/proceedings/2011/458). A mobile sensor chooses observation detours while accounting for motion cost, detector errors, and correlation between successive observations. This directly motivates BeliefView's travel penalty and explicit repeated-look rule. Its object-identification task and observation-correlation model are richer than BeliefView's.

4. Timothy H. Chung and Rachel T. Silvestrini, ["Modeling and Analysis of Exhaustive Probabilistic Search" (Naval Research Logistics 2014)](https://onlinelibrary.wiley.com/doi/10.1002/nav.21574). This analyzes Bayesian presence/absence search with imperfect detections and the correctness of search decisions for a single static target. It motivates reporting outside-state decisions and false declarations separately. It is an analytic static-target search model, not a validation of BeliefView's moving-subject motion or exit prior.

## Implications for this repository

- Describe BeliefView as a small educational active-search experiment. Do not claim POMDP-solver novelty, optimal search, real visual tracking, or transfer to drone operations.
- Report the effect of negative evidence with an ablation that holds all other planner settings fixed. A separately tuned planner is a different policy comparison, not a clean ablation.
- Label the stated region's probability relative to the whole state space or explicitly say it is conditional on the subject remaining inside. Compute in-map region coverage only among evaluation cases where the subject is still inside; report outside decisions separately.
- State that the synthetic sensor has no false positives, unlike real visual detectors and some cited studies.
