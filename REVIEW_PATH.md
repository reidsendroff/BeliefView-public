# Four-hour review path (Reid's own time)

Everything here uses synthetic data. Budget: 240 minutes. Stop and cut any claim you still cannot explain at the end.

## 0:00-0:20 Orient (20 min)
- Open `demo/index.html` in a browser (double-click; no server or network). Pause and scrub both clips and read the legend.
- Read `README.md` (the short landing page), then `docs/TECHNICAL_REPORT.md` (the full report) top to bottom. Open `results/v2/map.png`, `results/v2/comparison.png`. v2 is the headline; files directly in `results/` are the earlier v1 record.
- Run the one command and watch it finish: `make all` (tests first, then it rebuilds the v2 tables, figures, animations and demo from the saved records; see README "Run it locally" for runtime). It does not rerun the v2 final experiment: that ran once, and `make v2-final` refuses a second run.

## 0:20-1:10 Hand-calculate one missed-detection update (50 min)
1. Open `tests/test_belief.py::test_analytic_posterior_with_outside_mass`.
2. On paper: 0.3 mass in a visible cell with P(detect)=q, 0.5 mass hidden behind a rock, 0.2 already outside. Write the posterior of each of the three after a miss (Z = 0.3(1-q) + 0.5 + 0.2).
3. Use q = 0.64 (the visible cell) from `geo.pd_field(...)` (run the REPL snippet in README "Hand-check") and verify your numbers against the test's output.
4. Then answer: why does the hidden cell *rise*? Why does `outside` rise?

## 1:10-2:10 Change one assumption and rerun (60 min)
Pick ONE:
- Motion: `MotionAssumption.p_stop` (0.03) in `beliefview/config.py`, or `edge_exit_rate`.
- Sensor: `SensorParams.foliage_factor` in a scenario spec in `beliefview/experiment.py`.
Then run a small, fast check that does NOT touch the frozen test results:
The frozen runs refuse to run after a frozen-config change (that is intended), and the v2 final run cannot be repeated. Instead use scratch work on the dev split, which leaves the code and the frozen results alone:
`.venv/bin/python scripts/what_if.py --scenario B_motion_mismatch --n 20 --set assumed_motion.p_stop=0.1`
Record before/after reacquired-by-deadline for BeliefView and the baselines in your own notes, and write one sentence on *why* it moved (or did not).

## 2:10-2:50 Explain one planner decision (40 min)
- Play the representative clip in `demo/index.html` (or `results/v2/animation_representative.mp4`); step frame by frame and pause where the green star (chosen viewpoint) is far from the brightest heat.
- Run `.venv/bin/python scripts/explain_decision.py --scenario A_matched --idx 0 --t 4` to print the candidate table (gain, travel steps, score) for that step.
- Explain in two sentences why candidate X beat candidate Y (gain vs `lam * travel_steps`). In v2, lam = 0.004: each step of travel costs 0.004 of score, so a viewpoint 10 travel steps away must promise at least 0.04 more reacquisition probability within the 12-step horizon than holding position. lam was chosen on separate validation episodes as the largest of {0.0005, 0.001, 0.002, 0.004} whose reacquired fraction was within 0.03 of the best (see `results/v2/results.md`).
- Rerun the same command with `--config v1` (the earlier record, lam = 0, where travel had no explicit cost) and say what changed in the score column and, if it did, in the choice.

## 2:50-3:20 Failure and limitation (30 min)
- Play the failure clip in `demo/index.html` (or `results/v2/animation_failure.mp4`) and read the "Failures and honest limitations" section of `docs/TECHNICAL_REPORT.md` (the README has a shorter list under the same heading).
- Write down: one model-mismatch failure (from your own reading of the results), and one limitation of the 2D world.

## 3:20-4:00 Quiz and cut list (40 min)
- Answer `QUIZ.md` without notes, then check `QUIZ_ANSWER_KEY.md`.
- Strike from your talk anything you could not answer. Reserve Nov 23 for rehearsal; do not add features.

## Things to hold in mind
- The experiment is a synthetic 2D simulation; Claude helped write the code; Codex consulted Muse, Grok Bot and Antigravity and recorded their synthetic-only critiques in `REVIEW_NOTES.md` (an internal record, not published in this snapshot); Instinct was not consulted; Codex completed the independent local review, with its verdict recorded there (not published here).
- Nothing in this path counts as done until you have done it. The checklist in `CONTRIBUTIONS.md` is yours to tick.
- Do not describe results as drone performance.
