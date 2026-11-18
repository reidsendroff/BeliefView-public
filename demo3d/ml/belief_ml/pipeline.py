import hashlib, json, os, subprocess, time
import numpy as np
import torch
from . import data, export, metrics, model, train
from .provenance import feature_schema_sha256, source_hashes
from .episodes_cfg import PROFILES, SPLIT_SEEDS


def run(demo3d_dir, profile_name, log=print):
    cfg = dict(PROFILES[profile_name])
    root = os.path.join(demo3d_dir, "ml")
    data_dir = os.path.join(root, "data", profile_name)
    res_dir = os.path.join(root, "results")
    model_id = cfg["model_id"]
    out_dir = os.path.join(demo3d_dir, "public", "models", model_id)
    os.makedirs(res_dir, exist_ok=True); os.makedirs(out_dir, exist_ok=True)
    train.seed_everything(cfg["seed"])
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"profile={profile_name} device={device} torch={torch.__version__}")

    paths = {}
    for split in ("train", "val", "test"):
        paths[split] = os.path.join(data_dir, f"{split}.jsonl.gz")
        t0 = time.time()
        status = data.generate(demo3d_dir, split, cfg["episodes"][split], paths[split], log=log)
        log(f"{split}: {cfg['episodes'][split]} episodes -> {paths[split]} [{status}] ({time.time() - t0:.0f}s)")
    D = {k: data.load(p) for k, p in paths.items()}
    splits = {}
    for k, d in D.items():
        s0 = SPLIT_SEEDS[k]
        n_ep = cfg["episodes"][k]
        splits[k] = {"worldSeeds": [s0[0], s0[0] + n_ep - 1], "subjectSeeds": [s0[1], s0[1] + n_ep - 1], "episodes": n_ep, "samples": int(len(d["codes"])),
                     "truthOutsideGrid": int((~d["inside"]).sum())}
        log(f"  {k}: {splits[k]}")
    ds_hash = __import__("hashlib").sha256("".join(data.file_sha256(paths[k]) for k in ("train", "val", "test")).encode()).hexdigest()

    net, n_params, hist = train.fit(D["train"], D["val"], cfg, device, log)
    net = net.cpu()
    pv = train.predict(net, D["val"], "cpu")
    q95, k_kal = metrics.fit_calibration(D["val"], pv)
    log(f"calibration (val only): ml region mass level {q95}, kalman radius scale {k_kal}")
    pt = train.predict(net, D["test"], "cpu")
    rep = metrics.offline_report(D["test"], pt, q95, k_kal)
    rep["_val_reference"] = metrics.offline_report(D["val"], pv, q95, k_kal)["all"]

    onnx_path = os.path.join(out_dir, "model.onnx")
    export.export_onnx(net, onnx_path)
    os.makedirs(os.path.join(root, "fixtures"), exist_ok=True)
    parity = export.make_fixtures(os.path.join(root, "fixtures", "parity.json"), onnx_path, D["test"], net, n=8)
    # full-test ONNX parity (python onnxruntime) on a subsample
    sub = np.linspace(0, len(D["test"]["codes"]) - 1, min(200, len(D["test"]["codes"]))).astype(int)
    op = export.ort_predict(onnx_path, D["test"]["codes"][sub], D["test"]["scalars"][sub])
    max_diff = float(np.abs(op - pt[sub]).max())
    log(f"ONNX (python onnxruntime) vs torch on {len(sub)} test samples: max|diff| = {max_diff:.2e}; fixtures max|diff| = {parity:.2e}")

    git = export.git_info(os.path.dirname(demo3d_dir))
    arch = model.describe(cfg["channels"], cfg["dilations"], cfg["scalar_embed"], cfg["dropout"])
    all_t = rep["all"]
    dev_test = {"split": "test (development: seen while tuning, not a pristine holdout)", "coverage": all_t["region95_calibrated_ml"]["coverage"], "samples": all_t["samples"],
                "episodes": all_t["episodes"], "medianAreaM2": all_t["region95_calibrated_ml"]["median_area_m2"]}
    manifest = export.build_manifest(model_id, cfg["version"], onnx_path, n_params, arch, cfg, splits, ds_hash, q95, device, git, "", demo3d_dir, dev_test)
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2); f.write("\n")
    summary = {"evaluationRole": "DEVELOPMENT (train/val/test); the final claims are in final_audit_*.json", "modelSha256": manifest["model"]["sha256"], "datasetSha256": ds_hash,
               "sourceSha256": manifest["source"]["sourceSha256"]["combined"], "featureSchemaSha256": feature_schema_sha256(),
               "profile": profile_name, "device": device, "training_history": hist, "onnx_vs_torch_max_abs_diff_200_test_samples": max_diff,
               "parity_fixture_max_abs_diff": parity, "splits": splits, "offline_test": rep, "model_bytes": manifest["model"]["bytes"], "parameters": int(n_params)}
    with open(os.path.join(res_dir, "offline_metrics.json"), "w") as f:
        json.dump(summary, f, indent=2); f.write("\n")
    return summary


def audit(demo3d_dir, profile_name, log=print, force=False):
    """FINAL AUDIT of the FROZEN model on a fresh split (world 60000+, subject 65000+) disjoint from train/val/old test.
    Nothing is tuned here: the model, calibration level and Kalman scale come from the already-written manifest / offline_metrics.json.
    Writes ml/results/final_audit_offline.json and final_audit_closed_loop.json and records the measured coverage in the manifest."""
    cfg = dict(PROFILES[profile_name])
    root = os.path.join(demo3d_dir, "ml")
    res_dir = os.path.join(root, "results")
    out_dir = os.path.join(demo3d_dir, "public", "models", cfg["model_id"])
    mpath = os.path.join(out_dir, "manifest.json")
    manifest = json.load(open(mpath))
    onnx_path = os.path.join(out_dir, manifest["model"]["file"])
    sha = export.sha256_file(onnx_path)
    if sha != manifest["model"]["sha256"]:
        raise RuntimeError("model.onnx does not match the manifest hash; refusing to audit a model that is not the frozen one")
    dev = json.load(open(os.path.join(res_dir, "offline_metrics.json")))
    if dev["modelSha256"] != sha:
        raise RuntimeError("offline_metrics.json belongs to a different model; re-run the pipeline first")
    off_path = os.path.join(res_dir, "final_audit_offline.json")
    if os.path.exists(off_path) and not force and json.load(open(off_path)).get("modelSha256") == sha:
        log("final audit already recorded for this exact model hash; not re-running (set force=True to repeat; do not tune on it)")
        return json.load(open(off_path))
    n = cfg["episodes"]["audit"]
    ap = os.path.join(root, "data", profile_name, "audit.jsonl.gz")
    status = data.generate(demo3d_dir, "audit", n, ap, log=log)
    A = data.load(ap)
    prob = export.ort_predict(onnx_path, A["codes"], A["scalars"])
    q95 = manifest["calibration"]["region95"]["massLevel"]
    k_kal = dev["offline_test"]["_calibration"]["kalman_radius_scale"]
    rep = metrics.offline_report(A, prob, q95, k_kal)
    s0 = __import__("belief_ml.episodes_cfg", fromlist=["SPLIT_SEEDS"]).SPLIT_SEEDS["audit"]
    out = {"evaluationRole": "FINAL AUDIT: fresh split, frozen model, no tuning", "modelSha256": sha, "sourceSha256": manifest["source"]["sourceSha256"]["combined"],
           "datasetAuditSha256": data.file_sha256(ap), "dataCache": status,
           "split": {"worldSeeds": [s0[0], s0[0] + n - 1], "subjectSeeds": [s0[1], s0[1] + n - 1], "episodes": n, "samples": int(len(A["codes"])), "truthOutsideGrid": int((~A["inside"]).sum())},
           "calibrationUsed": {"ml_region_mass_level": q95, "kalman_radius_scale": k_kal, "fit_on": "val only (from the dev run)"},
           "offline": rep}
    with open(off_path, "w") as f:
        json.dump(out, f, indent=2); f.write("\n")
    a = rep["all"]
    log(f"final audit offline: {a['samples']} samples / {a['episodes']} episodes; calibrated region coverage {a['region95_calibrated_ml']['coverage']:.3f} (target 0.95)")
    clp = os.path.join(res_dir, "final_audit_closed_loop.json")
    subprocess.run(["npx", "tsx", "tools/eval_closed_loop.ts", "--model", out_dir, "--count", str(n), "--split", "audit", "--out", clp], cwd=demo3d_dir, check=True)
    export.attach_audit(mpath, {"split": "audit (fresh, disjoint, frozen model, never tuned on)", "coverage": a["region95_calibrated_ml"]["coverage"], "samples": a["samples"],
                                "episodes": a["episodes"], "medianAreaM2": a["region95_calibrated_ml"]["median_area_m2"]})
    return out
