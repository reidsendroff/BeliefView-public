import hashlib, json, os, subprocess
import numpy as np
import onnx
import onnxruntime as ort
import torch
from . import CHANNELS, EXTRACTOR_VERSION, GRID_N, N_CHANNELS, N_SCALARS, SCALARS, SCALAR_NORM
from .model import ExportNet
from .provenance import feature_schema_sha256, source_hashes

CHANNEL_DOC = {
    "canopy_cover": "known map: fraction of the cell under tree canopy (4x4 sub-samples of a 1 m raster)",
    "trunk_proximity": "known map: fraction of the cell within trunk radius + 1.2 m (plausible hiding spots)",
    "sensor_visible_now": "known map + drone pose: cell is inside the camera FOV/range with map line of sight right now",
    "sensor_visible_memory": "same, remembered since the last fix (decays with 25 s time constant); reset on every fix",
    "extrapolated_position": "gaussian blob at last fix + least-squares velocity (last 2 s of fixes) * elapsed",
    "reachable_radius": "1 - distance from last fix / (6.3 m/s * elapsed + 2 m), clipped to [0, 1]",
    "drone_position": "gaussian blob (sigma 1 cell) at the drone's own position",
    "terrain_height": "known map: (terrain height / 8 + 1) / 2",
}


def export_onnx(net, path, opset=17):
    net = net.cpu().eval()
    wrapped = ExportNet(net).eval()
    g = torch.zeros(1, N_CHANNELS, GRID_N, GRID_N)
    s = torch.zeros(1, N_SCALARS)
    torch.onnx.export(wrapped, (g, s), path, input_names=["grid", "scalars"], output_names=["prob"],
                      dynamic_axes={"grid": {0: "batch"}, "scalars": {0: "batch"}, "prob": {0: "batch"}},
                      opset_version=opset, dynamo=False)
    # fold external data (if any) into one file and validate
    m = onnx.load(path)
    onnx.checker.check_model(m)
    onnx.save(m, path, save_as_external_data=False)
    return wrapped


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def ort_predict(path, codes, scalars):
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out = []
    for k in range(len(codes)):
        out.append(sess.run(["prob"], {"grid": (codes[k:k + 1].astype(np.float32) / 255.0).astype(np.float32), "scalars": scalars[k:k + 1].astype(np.float32)})[0][0])
    return np.stack(out)


def make_fixtures(path, onnx_path, test, torch_net, n=8):
    """Parity fixtures: exact model inputs + torch outputs; re-derivable features via (split, world seed, subject seed, frame)."""
    idx = np.linspace(0, len(test["codes"]) - 1, n).astype(int)
    codes, scalars = test["codes"][idx], test["scalars"][idx]
    with torch.no_grad():
        tp = torch.softmax(torch_net.eval()(torch.from_numpy(codes).float() / 255.0, torch.from_numpy(scalars)), 1).numpy()
    op = ort_predict(onnx_path, codes, scalars)
    import base64
    fx = {"schemaVersion": 1, "tolerance": 1e-5, "torchVsOnnxRuntimePythonMaxAbs": float(np.abs(tp - op).max()), "samples": []}
    for a, k in enumerate(idx):
        fx["samples"].append({"split": "test", "worldSeed": int(test["w"][k]), "subjectSeed": int(test["s"][k]), "frame": int(test["i"][k]),
                              "codes_b64": base64.b64encode(codes[a].tobytes()).decode(), "scalars": [float(v) for v in scalars[a]],
                              "prob": [float(v) for v in tp[a]]})
    with open(path, "w") as f:
        json.dump(fx, f, separators=(",", ":"))
    return fx["torchVsOnnxRuntimePythonMaxAbs"]


def git_info(repo):
    """Best-effort commit info (an uploaded zip has no .git). Any credentials embedded in a remote URL are stripped."""
    import re

    def run(*a):
        try:
            return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True).stdout.strip()
        except OSError:
            return ""
    dirty = bool(run("status", "--porcelain", "--untracked-files=no"))
    remote = re.sub(r"//[^/@]*@", "//", run("config", "--get", "remote.origin.url"))
    return {"commit": run("rev-parse", "HEAD") or "unknown", "dirty": dirty, "remote": remote}


def build_manifest(model_id, version, onnx_path, n_params, arch, cfg, splits, ds_hash, q95, device, git, notebook, demo3d_dir, dev_test=None):
    src = source_hashes(demo3d_dir)
    return {
        "schemaVersion": 1,
        "modelId": model_id,
        "modelVersion": version,
        "synthetic": True,
        "description": "Probability grid over where the simulated evasive subject is, after fixes stop. Trained only on synthetic episodes from the BeliefView 3D simulator.",
        "model": {
            "file": os.path.basename(onnx_path), "format": "onnx", "sha256": sha256_file(onnx_path), "bytes": os.path.getsize(onnx_path), "opset": 17,
            "inputs": [{"name": "grid", "shape": [1, N_CHANNELS, GRID_N, GRID_N], "dtype": "float32"}, {"name": "scalars", "shape": [1, N_SCALARS], "dtype": "float32"}],
            "outputs": [{"name": "prob", "shape": [1, GRID_N * GRID_N], "dtype": "float32"}],
        },
        "features": {
            "extractorVersion": EXTRACTOR_VERSION,
            "grid": {"n": GRID_N, "cellMeters": 4, "centre": "world xz of the last noisy observation (the model is never run before the first fix; no start position is an input)",
                     "layout": "grid[channel][row=z][col=x]; cell centre = centre + ((col+0.5-N/2)*cell, (row+0.5-N/2)*cell); prob has the same row-major cell order"},
            "channels": [{"index": i, "name": n, "description": CHANNEL_DOC[n]} for i, n in enumerate(CHANNELS)],
            "gridQuantisation": "values are uint8 codes / 255 (extractor emits exactly these)",
            "scalars": [{"index": i, "name": n, "scale": SCALAR_NORM[n][0], "min": SCALAR_NORM[n][1], "max": SCALAR_NORM[n][2]} for i, n in enumerate(SCALARS)],
        },
        "output": {"name": "prob", "softmaxInGraph": True,
                   "interpretation": "P(subject is in cell) at the prediction time, given observations so far. Sums to 1 over the grid; subject outside the 128 m grid is not modelled."},
        "calibration": {"region95": {
            "massLevel": q95, "fitSplit": "val", "fitSamples": int(splits["val"]["samples"]), "targetCoverage": 0.95,
            "statement": "Validation-calibrated region: highest-probability cells until mass >= massLevel, with massLevel fitted on the validation split to TARGET 95% coverage. Coverage on other data is measured, not guaranteed (see measured).",
            "measured": {"developmentTest": dev_test} if dev_test else {}}},
        "training": {
            "architecture": arch, "parameters": int(n_params),
            "seeds": {"training": cfg["seed"], **{f"{k}_world0": v["worldSeeds"][0] for k, v in splits.items()}, **{f"{k}_subject0": v["subjectSeeds"][0] for k, v in splits.items()}},
            "splits": splits,
            "loss": f"cross-entropy on the true cell; AdamW lr {cfg['lr']} (OneCycle), weight decay {cfg['weight_decay']}, dropout {cfg['dropout']}, batch {cfg['batch']}, {cfg['epochs']} epochs max, early stop (patience {cfg['patience']}) on val NLL; best-val-epoch weights shipped",
            "framework": f"torch {torch.__version__}, onnx {onnx.__version__}", "device": device,
            "datasetSha256": ds_hash, "notebook": "demo3d/ml/BeliefView3D_ml_training.ipynb",
        },
        "source": {"repository": git["remote"] or "unknown", "generatorCommit": git["commit"] + ("+dirty" if git["dirty"] else ""),
                   "generatorCommitNote": "parent commit only; the working tree may be dirty/uncommitted, so sourceSha256 (exact file contents) is the authoritative provenance",
                   "simulator": "demo3d/src/sim (TypeScript, Kalman data-collection policy with the coarse start set-up)",
                   "sourceSha256": src, "featureSchemaSha256": feature_schema_sha256()},
        "limitations": [
            "Trained and evaluated only on synthetic simulator episodes of a hand-written evasive subject; says nothing about real people, real drones or real forests.",
            "Training data were collected under the Kalman guidance policy (coarse-start set-up); closed-loop use under learned guidance is a distribution shift.",
            "The drone is set up from a coarse (16 m cell) designated start area; the model receives no start position and is only run after the first noisy fix.",
            "The 95% region is validation-calibrated (target 95%); measured held-out coverage differs and is reported in calibration.region95.measured, not guaranteed.",
            "The grid covers 128 m x 128 m around the last fix; subject mass outside it is not modelled.",
            "Illustrative demo model: no safety, field-performance or clinical claims.",
        ],
    }


def attach_audit(manifest_path, audit):
    """Record the frozen-model final-audit coverage in the manifest (model bytes/hash are untouched)."""
    m = json.load(open(manifest_path))
    m["calibration"]["region95"].setdefault("measured", {})["finalAudit"] = audit
    with open(manifest_path, "w") as f:
        json.dump(m, f, indent=2); f.write("\n")
