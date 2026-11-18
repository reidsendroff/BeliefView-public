# demo3d/ml — learned search-belief model (synthetic simulator only)

Everything here is trained and evaluated on episodes from the BeliefView 3D demo simulator (procedural forest + hand-written evasive
subject). It is not the frozen BeliefView v2 experiment and supports no real-world claim.

## Files

| path | what |
|---|---|
| `BeliefView3D_ml_training.ipynb` | Colab/local notebook (built by `make_notebook.py`, shipped **executed**): data → train → calibrate → offline eval → ONNX + manifest + fixtures → closed-loop eval → `RESULTS.md` |
| `belief_ml/` | Python package: `data.py` (loads TS-generated JSONL), `model.py` (compact dilated CNN), `train.py` (seeded training), `metrics.py` (NLL, position error, calibrated 95 % region), `export.py` (ONNX, manifest, fixtures), `pipeline.py`, `report.py`, `episodes_cfg.py` (profiles, seed ranges) |
| `../tools/gen_episodes.ts` | generates JSONL.gz with the **real TypeScript simulator** and the same feature extractor the browser uses (no Python subject mirror) |
| `../tools/eval_closed_loop.ts` | Kalman vs learned guidance on identical held-out scenarios, running the exported ONNX |
| `../src/ml/` | `features.ts` (inference feature extractor / trust boundary), `belief.ts`, `guidance.ts` (viewpoint scoring), `model.ts` + `manifest.ts` + `sha256.ts` (loader, validator), `boot.ts`, `ortWeb.ts`, plus evaluation-only `scenarios.ts`, `closedLoop.ts`, `episodes.ts` |
| `../public/models/beliefview3d-search-v1/` | shipped `model.onnx` + `manifest.json` |
| `fixtures/parity.json` | exact inputs + torch outputs; vitest checks onnxruntime-web against them and re-derives the features |
| `results/*.json`, `RESULTS.md` | measured outputs: `offline_metrics.json` + `closed_loop.json` (development), `final_audit_offline.json` + `final_audit_closed_loop.json` (final audit), `browser_smoke.json`; every file carries the model sha256; `RESULTS.md` is generated from the JSON |
| `data/` | generated datasets (git-ignored) |

## Model interface (see `manifest.json` for the authoritative copy)

* inputs `grid` `[1,8,32,32]` (uint8 codes / 255; channels: canopy cover, trunk proximity, sensor-visible-now, sensor-visible-memory,
  extrapolated position, reachable radius, drone position, terrain height) and `scalars` `[1,13]` (elapsed, time, fix sigma,
  estimated velocity, drone AGL / gimbal / offset from grid centre, recent fix count). There is **no start-position input** (v2 removed the start-hint scalars and `has_fix`) with the normalisation recorded in the manifest;
* output `prob` `[1,1024]`: P(subject in cell) over a 32×32 grid of 4 m cells centred on the last noisy fix (the model is not run before the first fix); softmax is inside the graph;
* labels = the true subject cell at the prediction tick (truth is a training target only); the *validation-calibrated region* is "highest-probability cells until
  mass ≥ q" where q is fitted on the validation split (split-conformal, **target** 95 %) and stored in the manifest together with the **measured** held-out coverage (development test and final audit). Coverage is measured, not guaranteed.

## Run it

Local (CPU, ~15–25 min for the `local` profile; needs Node ≥ 20 and `npm ci` in `demo3d/`):

```bash
cd demo3d && npm ci
python -m pip install torch onnx onnxruntime numpy nbformat nbclient ipykernel   # any recent versions
python ml/make_notebook.py                              # (re)build the notebook
BV_ML_PROFILE=local jupyter nbconvert --to notebook --execute --inplace ml/BeliefView3D_ml_training.ipynb
```
Profiles: `smoke` (wiring only; do not ship), `local` (what produced the committed weights), `colab` (larger).

### Google Colab with the private repository (no token is ever used)

The notebook does **not** read, accept or pass a GitHub credential (nothing in a process argument list, log or git config). Provide the repository yourself:

1. On your machine: commit, then `git archive --format=zip -o BeliefView.zip HEAD demo3d` (or zip `demo3d/` without `node_modules`, `ml/data`, `.playwright-cli`).
2. In Colab upload `BeliefView.zip` to `/content` (or point `BV_REPO_ZIP` at a Drive path). Alternatively make `/content/BeliefView/demo3d` exist some other way (`BV_REPO` overrides the path).
3. Choose a CPU or GPU runtime and *Run all*. The notebook unzips, runs `npm ci`, trains, exports, runs the closed loop and the final audit.
4. Download `public/models/<id>/`, `ml/fixtures/parity.json`, `ml/results/*.json` and `ml/RESULTS.md`. Re-run `npm test` and `npm run test:browser` locally before committing weights.

### Cache integrity

`belief_ml/data.generate` reuses a cached dataset only when its `<file>.meta.json` matches the request exactly (split/seeds, episode count, extractor version, SHA-256 of the exact simulator/feature/generator sources) **and** the content hash and episode count verify. Otherwise it regenerates to a temp file and renames atomically. `ml/tests/test_data_cache.py` covers count/split/source/tamper/no-metadata staleness (`python -m unittest discover -s ml/tests`).

### Provenance

`manifest.json` records `source.sourceSha256` (per-file SHA-256 + combined hash of the simulator, feature extractor, episode/scenario code, generator and Python feature/split mirrors) and `source.featureSchemaSha256`, in addition to the parent git commit (which may not describe an uncommitted working tree). A vitest test re-hashes those files and fails if the shipped model was not trained with the sources now on disk.

### Evaluation protocol

* `train` 1000+/5000+, `val` 20000+/25000+: fitting and early stopping / calibration.
* `test` 40000+/45000+: **development only**. Earlier model versions were tuned while looking at it, so it is not a pristine holdout.
* `audit` 60000+/65000+ (100 episodes): created after the design was frozen, evaluated once on the frozen model (`pipeline.audit`), never tuned on. Final claims come only from `ml/results/final_audit_*.json` / section 1 of `RESULTS.md`; development results are reported separately. A second look at the audit split would also turn it into a development split.

## Honest limitations

* Synthetic simulator, hand-written subject; the model learns this simulator's habits (it hides at nearby trees, jinks, …).
* Training/validation/test logs are collected under **Kalman guidance**; running the learned guidance in closed loop is a distribution shift,
  and the subject reacts to the drone, so closed-loop paired runs diverge.
* The grid is 128 m × 128 m around the last fix; subject mass beyond it (≈1–2 % of lost-run ticks) is not modelled and counts as a miss for coverage.
* Metrics come from `local`-profile sizes (900/60/100 episodes, final audit 100); confidence intervals are wide. Never read `RESULTS.md` as a claim of improvement unless it says the CI excludes zero.
