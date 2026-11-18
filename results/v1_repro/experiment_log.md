# Experiment log

- beliefview 2.0.0; python 3.14.6; numpy 2.5.4; matplotlib 3.11.2
- frozen config hash: `222bce7e37097894` (verified before the test run)
- chosen hyperparameters (tuned on validation only): `{"lam": 0.0, "orbit_margin": 2.0, "scan_yaw_deg": 45.0, "tau_left": 0.9}`
- BeliefView and its no-miss-update ablation share one planner setting (`planner`, including `lam`); the ablation has no separately tuned parameter
- paired across policies: episode (trajectory, start, last-seen), per-step detection uniforms and measurement noise; NOT paired: the observations themselves, which depend on each policy's viewpoint
- base seed 20261114; episode streams = SeedSequence([base, scenario_idx, split_id(dev=0,val=1,test=2), idx])
- test episodes per scenario: 100; scenarios: ['A_matched', 'B_motion_mismatch', 'C_sensor_mismatch', 'D_exit_mismatch']; deadline 80
- exit-rate sweep assumed values: [0.0, 0.01, 0.03, 0.08, 0.2] (scenario D, BeliefView only)
- max |sum(belief)+outside - 1| over all test runs: 5.11e-15
- wall time of this run: 517s
- animations: representative=animation_representative.mp4 (A_matched ep 5); failure=animation_failure.mp4 (B_motion_mismatch ep 20)
- raw per-episode records: results/test_records.jsonl, results/exit_sweep_records.jsonl
