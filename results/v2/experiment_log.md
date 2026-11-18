# v2 experiment log

- beliefview 2.0.0; python 3.14.6; numpy 2.5.4; matplotlib 3.11.2
- v2 frozen at 2026-11-14T17:57:20-05:00: config hash `a69bfac2342ac108`, protocol hash `005759e5dd0fd210` (both verified before the final run)
- source: core (simulation/inference/protocol) checksum at freeze `964103366f5b5762`, at the final run `964103366f5b5762`, when this log was written `964103366f5b5762`; git revision at the final run: 38ebecd + uncommitted changes in beliefview/; report-code checksum when this log was written `933be0cdd82aba12` (analysis, plots, animate, cli, v2_report, demo)
- chosen: `{"lam": 0.004, "orbit_margin": 2.0, "scan_yaw_deg": 45.0, "tau_left": 0.9}`; lam selected on validation split id 3 (grid [0.0005, 0.001, 0.002, 0.004], rule: select the largest lam whose combined (A+B) reacquired-by-deadline fraction is within 0.03 absolute of the best fraction on the grid; lam = 0 is not a candidate); orbit margin, scan yaw and tau_left are the v1 values, not re-tuned
- BeliefView and its no-miss-update ablation share one planner setting (`planner`, including `lam`); every final record stores the `planner_lam` it ran with, and the report asserts belief == belief_noneg == selected, belief_lam0 == 0
- `belief_lam0`: lam = 0 reference arm on the same final episodes; labelled, not a tuning candidate, not a headline
- paired across policies: episode (trajectory, start, last-seen), per-step detection uniforms and measurement noise; NOT paired: the observations themselves, which depend on each policy's viewpoint
- base seed 20261114; episode streams = SeedSequence([base, scenario_idx, split_id, idx]); v2 split ids: v2_val=3 (tuning), v2_final=4 (final); v1 used 0, 1, 2
- final episodes per scenario: 200 (split `v2_final`); scenarios: ['A_matched', 'B_motion_mismatch', 'C_sensor_mismatch', 'D_exit_mismatch']; deadline 80
- final run started 2026-11-14T17:57:30-05:00, completed 2026-11-14T18:16:46-05:00, episode wall time 1155s; `results/v2/FINAL_RUN_LOCK.json` blocks a second inferential run
- exit-rate sweep assumed values: [0.0, 0.01, 0.03, 0.08, 0.2] (scenario D, BeliefView only)
- max |sum(belief)+outside - 1| over all final runs: 5.00e-15
- animations (illustrative, selected by outcome): representative=animation_representative.mp4 (A_matched ep 23); failure=animation_failure.mp4 (B_motion_mismatch ep 0)
- raw per-episode records: results/v2/final_records.jsonl, results/v2/exit_sweep_records.jsonl, results/v2/validation_records.jsonl
- this log is rewritten by `v2-report`, which recomputes tables from the saved records and runs no new episodes other than the two deterministic animation replays
