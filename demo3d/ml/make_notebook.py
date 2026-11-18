"""Builds BeliefView3D_ml_training.ipynb (run: python ml/make_notebook.py). The notebook itself is the executable artifact."""
import nbformat as nbf

nb = nbf.v4.new_notebook()
md, code = nbf.v4.new_markdown_cell, nbf.v4.new_code_cell
cells = []
cells.append(md("""# BeliefView 3D — learned search-belief model (synthetic simulator data only)

> **Synthetic / illustrative.** Everything here is trained and evaluated on episodes from the *BeliefView 3D demo simulator*
> (a procedural forest and a hand-written evasive subject). Nothing about real people, drones or forests can be concluded.
> It is unrelated to the frozen BeliefView v2 2D experiment and its metrics.

**What this notebook does** (CPU or GPU runtime, seeded):

1. Generates varied episodes with the **real TypeScript simulator** (`demo3d/tools/gen_episodes.ts`) — different world seeds, subject-policy seeds and start/goal jitter; splits are disjoint in both world and subject seeds. There is no Python re-implementation of the subject policy.
2. Builds model inputs with the **same TypeScript feature extractor used in the browser**: observation history, elapsed time, drone pose and the *known* map only. **No start position of any kind is an input**, and samples exist only after the first noisy fix; the drone itself is set up from a coarse 16 m designated area. Labels (true subject cell) come from simulator truth and are used only as training targets / evaluation.
3. Trains a compact CNN that outputs a **probability grid** (32×32 cells × 4 m) over where the subject may be once fixes stop.
4. Calibrates a *validation-calibrated* region (target 95 %) on the validation split and evaluates the development test split against the Kalman tracker (offline predictive metrics). Coverage is reported as measured, never as guaranteed.
5. Exports **ONNX + a versioned manifest** (feature order, normalisation, grid/output interpretation, seeds/splits, architecture, exact source-file SHA-256s, feature-schema hash, model sha256) and parity fixtures.
6. Runs the closed-loop comparison (Kalman vs learned guidance, both with the same coarse start) on the development test scenarios.
7. **Freezes the model and runs a final audit** on a fresh split (world 60000+, subject 65000+) disjoint from train/val/old test — never tuned on — then writes `demo3d/ml/RESULTS.md`.

Offline prediction metrics and closed-loop search outcomes are reported **separately**; good offline numbers do not imply better search."""))
cells.append(md("""## 0. Setup (local checkout, or Google Colab with a pre-cloned / uploaded repository)

The repository is private. **This notebook never handles a GitHub credential**: no token is read, typed, put in a command line, a log or a git config. Provide the repository one of these ways:

* **Local**: run the notebook from `<repo>/demo3d/ml` (the repository is detected with `git rev-parse`).
* **Colab, uploaded archive (recommended)**: on your machine run `git archive --format=zip -o BeliefView.zip HEAD demo3d` (commit first, since `git archive` omits uncommitted work; or zip the `demo3d/` folder without `node_modules`, `ml/data` and `.playwright-cli`), upload `BeliefView.zip` to `/content` (or mount Google Drive and set `BV_REPO_ZIP`), then run the cell below. It unzips to `/content/BeliefView`.
* **Colab, pre-cloned**: make the repository available yourself, outside this notebook (for example copied from Drive), so that `/content/BeliefView/demo3d` exists, or set `BV_REPO` to its path.

Runtime: **CPU is fine** (the shipped weights were trained on CPU); a GPU runtime is detected automatically. Node ≥ 20 is required for the simulator CLI (Colab ships with it)."""))
cells.append(code('''import os, subprocess, sys, shutil, zipfile

IN_COLAB = "google.colab" in sys.modules

def sh(cmd, cwd=None, quiet=False):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({r.returncode}):\\n" + (r.stdout + r.stderr)[-3000:])
    if not quiet and r.stdout.strip():
        print(r.stdout.strip()[-1500:])
    return r.stdout.strip()

def find_repo():
    env = os.environ.get("BV_REPO")
    if env and os.path.isdir(os.path.join(env, "demo3d")):
        return env
    if not IN_COLAB:
        try:
            return sh(["git", "rev-parse", "--show-toplevel"], quiet=True)    # local run: notebook lives in <repo>/demo3d/ml
        except Exception:
            pass
    pre = "/content/BeliefView"
    if os.path.isdir(os.path.join(pre, "demo3d")):
        return pre
    zp = os.environ.get("BV_REPO_ZIP", "/content/BeliefView.zip")
    if os.path.exists(zp):
        with zipfile.ZipFile(zp) as z:
            z.extractall(pre)
        if os.path.isdir(os.path.join(pre, "demo3d")):
            return pre
    raise RuntimeError("Repository not found. Upload BeliefView.zip (git archive of demo3d) to /content, or pre-clone it so that /content/BeliefView/demo3d exists, or set BV_REPO / BV_REPO_ZIP. This notebook does not ask for or use any GitHub token.")

REPO = find_repo()
DEMO = os.path.join(REPO, "demo3d")
print("repo:", REPO)'''))
cells.append(code('''# Dependencies. torch is preinstalled on Colab; on a fresh machine the CPU build is installed. onnx/onnxruntime are small. Node/npm drive the real TypeScript simulator.
import importlib.util
missing = [m for m in ("torch", "onnx", "onnxruntime", "numpy") if importlib.util.find_spec(m) is None]
if "torch" in missing:
    missing.remove("torch")
    torch_cmd = [sys.executable, "-m", "pip", "install", "-q", "torch"]
    if not IN_COLAB:
        torch_cmd += ["--index-url", "https://download.pytorch.org/whl/cpu"]
    sh(torch_cmd, quiet=True)
if missing:
    sh([sys.executable, "-m", "pip", "install", "-q", *missing], quiet=True)
if shutil.which("node") is None:
    sh(["apt-get", "install", "-y", "-qq", "nodejs", "npm"], quiet=True)
print("node", sh(["node", "--version"], quiet=True))
if not os.path.isdir(os.path.join(DEMO, "node_modules")):
    sh(["npm", "ci", "--no-audit", "--no-fund"], cwd=DEMO)
sys.path.insert(0, os.path.join(DEMO, "ml"))   # makes `belief_ml` importable'''))
cells.append(md("""## 1. Configuration, seeds and device

Profiles (`demo3d/ml/belief_ml/episodes_cfg.py`): `smoke` (wiring check), `local` (what produced the committed weights, CPU) and `colab` (larger). Override with the env var `BV_ML_PROFILE`. Split seed ranges are disjoint in *both* world seed and subject seed: train 1000+/5000+, val 20000+/25000+, test 40000+/45000+ (a *development* split, seen while tuning), and the fresh final-audit split 60000+/65000+."""))
cells.append(code('''import json, torch
from belief_ml import pipeline, train
from belief_ml.episodes_cfg import PROFILES
PROFILE = os.environ.get("BV_ML_PROFILE", "colab" if IN_COLAB else "local")
cfg = PROFILES[PROFILE]
train.seed_everything(cfg["seed"])                      # python, numpy, torch (+cuda), deterministic algorithms
print("profile:", PROFILE, "| device:", "cuda" if torch.cuda.is_available() else "cpu", "| torch", torch.__version__)
print(json.dumps({k: cfg[k] for k in ("seed", "episodes", "epochs", "channels", "dilations", "batch", "lr")}))'''))
cells.append(md("""## 2. Generate data → train → calibrate → evaluate (offline) → export ONNX + manifest + fixtures

`pipeline.run` (a) calls the TypeScript generator for each split (a cached file is reused only if its metadata — episode count, split/seeds, extractor version, exact source hash — and content hash all verify; otherwise it is regenerated atomically), (b) trains with cross-entropy on the true cell and early-stops on validation NLL, (c) fits the region's mass level on **validation only** (split-conformal, *target* 95 %), (d) reports development-test metrics against the Kalman tracker, (e) exports `public/models/<id>/model.onnx` + `manifest.json` and `ml/fixtures/parity.json`, and checks ONNX vs torch."""))
cells.append(code('''summary = pipeline.run(DEMO, PROFILE)
print("model bytes:", summary["model_bytes"], "| parameters:", summary["parameters"])
print("ONNX vs torch (200 test samples) max|diff|:", summary["onnx_vs_torch_max_abs_diff_200_test_samples"])'''))
cells.append(md("## 3. Offline prediction results (DEVELOPMENT test split, Kalman-collected logs)"))
cells.append(code('''rep = summary["offline_test"]
cal = rep["_calibration"]
print("calibration fit on val only (target 95%; coverage below is MEASURED, not guaranteed):", cal)
def row(tag):
    r = rep[tag]
    if r.get("samples", 0) == 0: return f"{tag:6s} (no samples)"
    return (f"{tag:6s} n={r['samples']:5d} ep={r['episodes']:3d} | NLL ml {r['nll_nats_ml']:.2f} vs tracker-gauss {r['nll_nats_tracker_gaussian_uncalibrated']:.2f} vs uniform {r['nll_nats_uniform']:.2f}"
            f" | err m: ml-mean {r['err_m_ml_mean_estimate']['median']:.1f}, ml-MAP {r['err_m_ml_map_cell']['median']:.1f}, kalman {r['err_m_kalman_point']['median']:.1f}"
            f" | measured cov ml (target .95) {r['region95_calibrated_ml']['coverage']:.2f} (area {r['region95_calibrated_ml']['median_area_m2']:.0f} m2) kalman {r['region95_calibrated_kalman']['coverage']:.2f} (area {r['region95_calibrated_kalman']['median_area_m2']:.0f} m2)")
for tag in ["all", "hide", "turn", "long", "reacq"]:
    print(row(tag))'''))
cells.append(code('''try:
    import matplotlib.pyplot as plt
    h = summary["training_history"]
    plt.figure(figsize=(5, 3)); plt.plot([x["train_nll"] for x in h], label="train NLL"); plt.plot([x["val_nll"] for x in h], label="val NLL")
    plt.xlabel("epoch"); plt.ylabel("nats"); plt.legend(); plt.title("training curve"); plt.show()
except ImportError:
    print("matplotlib not installed; skipping plot")'''))
cells.append(md("""## 4. Closed-loop comparison on the development test split (separate from the offline metrics above)

Runs the real simulator on each scenario — Kalman guidance with the coarse start, the original exact-start Kalman demo (reference), and learned guidance (this ONNX file via onnxruntime in Node) — and compares search outcomes. The subject reacts to the drone, so the two runs' subject paths diverge; this is a paired but not a controlled counterfactual comparison."""))
cells.append(code('''N_EVAL = {"smoke": 3, "local": 100, "colab": 200}[PROFILE]
MODEL_DIR = os.path.join(DEMO, "public", "models", cfg["model_id"])
sh(["npx", "tsx", "tools/eval_closed_loop.ts", "--model", MODEL_DIR, "--count", str(N_EVAL), "--out", os.path.join(DEMO, "ml", "results", "closed_loop.json")], cwd=DEMO)
cl = json.load(open(os.path.join(DEMO, "ml", "results", "closed_loop.json")))
print(json.dumps({"overall": cl["overall"], "groupCounts": cl["groupCounts"], "mlWorse": cl["mlWorseEpisodes"]["count"]}, indent=1)[:2500])'''))
cells.append(code('''print("dev closed loop done; the model is now FROZEN. Nothing below may be used to tune it.")'''))
cells.append(md("""## 5. FINAL AUDIT on a fresh split (frozen model, never tuned on)

World seeds 60000+ / subject seeds 65000+: disjoint from train, validation and the development test split. The model, the validation-fitted region level and the Kalman scale are read from the already-written manifest / `offline_metrics.json`; nothing is refit. Results go to `ml/results/final_audit_offline.json` and `final_audit_closed_loop.json`, and the measured coverage is recorded in the manifest (the model bytes/hash do not change). If an audit for this exact model hash already exists it is reused, not repeated."""))
cells.append(code('''audit = pipeline.audit(DEMO, PROFILE)
a = audit["offline"]["all"]
print("model sha256:", audit["modelSha256"])
print(f"FINAL AUDIT offline: {a['samples']} samples / {a['episodes']} episodes | NLL ml {a['nll_nats_ml']:.2f} vs uniform {a['nll_nats_uniform']:.2f} | measured region coverage {a['region95_calibrated_ml']['coverage']:.3f} (target 0.95, median area {a['region95_calibrated_ml']['median_area_m2']:.0f} m2)")
ac = json.load(open(os.path.join(DEMO, "ml", "results", "final_audit_closed_loop.json")))
print(json.dumps({"overall": ac["overall"]["unobservedTotalS"], "firstLoss": ac["overall"]["firstLossSearchTimeS"], "mlWorse": ac["mlWorseEpisodes"]["count"]}, indent=1)[:1800])
from belief_ml import report
print(report.write(DEMO))   # writes demo3d/ml/RESULTS.md from the JSON files (browser latency is added by `npm run test:browser`)'''))
cells.append(md("""## 6. Artifacts

* `demo3d/public/models/<model_id>/model.onnx` and `manifest.json` (served to the browser; validated by schema + sha256 before use)
* `demo3d/ml/fixtures/parity.json` (exact inputs + torch outputs; the repo's vitest suite checks onnxruntime-web against them and re-derives the features with the TypeScript extractor)
* `demo3d/ml/results/offline_metrics.json`, `closed_loop.json` (development), `final_audit_offline.json`, `final_audit_closed_loop.json` (final audit), `browser_smoke.json`, `demo3d/ml/RESULTS.md`

Commit nothing from `demo3d/ml/data/` (generated, git-ignored)."""))
nb["cells"] = cells
nb["metadata"] = {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}, "colab": {"provenance": []}}
nbf.write(nb, "ml/BeliefView3D_ml_training.ipynb")
print("wrote notebook")
