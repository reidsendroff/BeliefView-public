# What is in this directory

- **`v2/` is the headline.** Frozen v2 protocol (`config/frozen_v2.json`): travel penalty lam = 0.004 chosen on new validation episodes (split id 3), one final run on 200 fresh episodes per scenario (split id 4). Start with `v2/results.md` or `demo/index.html`.
- **The files directly in this directory are the earlier v1 record**, unmodified (config hash `222bce7e37097894`, `config/frozen.json`). In v1, validation tuning chose lam = 0, so the travel penalty was inactive, and its 100 test episodes per scenario were run twice (before and after the fix pass). A byte-for-byte copy with SHA-256 checksums is in `archive/v1/` (`MANIFEST.sha256`); `tests/test_v2_demo_pass.py` checks both copies against it.
- `v1_repro/`, if present, is the output of a deliberate v1 reproduction (`make v1-repro`). `v2/repro_check/`, if present, is a labelled v2 reproducibility check. Neither is an inferential run.

v1 and v2 used different episodes. Their outcome tables are not merged and should not be averaged or compared row by row.

Everything here is a synthetic 2D simulation; nothing is a result about a real drone.
