"""Frozen v2 protocol (see DEMO_PASS_PLAN.md): tuning, freezing, the one final run, reporting.

What v2 changes relative to v1, and nothing else:
  * the travel penalty selection rule: one shared, strictly positive `lam`, chosen on NEW validation
    episodes (split id 3) as the largest grid value whose combined reacquired fraction is within
    0.03 absolute of the grid's best;
  * the episode streams: split ids 3 (validation) and 4 (final), which no earlier run used.
Map, scenarios, sensor, subject model, planner candidates/horizon/commit, orbit margin 2, scan
yaw 45 degrees and the outside threshold 0.9 are the v1 values and are not re-tuned.

`lam = 0` runs on the final episodes only as a labelled paired REFERENCE ARM (`belief_lam0`). It is
never a tuning candidate and never the headline.

Outputs: config/frozen_v2.json and results/v2/. The v1 record (config/frozen.json, results/ top
level, archive/v1/) is never written by anything in this module.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np

from .config import config_hash, to_jsonable
from .experiment import POLICIES, ROOT, SCENARIOS, build_config, load_records, run_tasks, save_records, tasks_for
from .world import SPLITS

FROZEN_V2 = ROOT / "config" / "frozen_v2.json"
V2_DIR = ROOT / "results" / "v2"
LOCK = V2_DIR / "FINAL_RUN_LOCK.json"

REFERENCE_ARM = "belief_lam0"
FINAL_POLICIES = POLICIES + [REFERENCE_ARM]
FIXED_FROM_V1 = {"orbit_margin": 2.0, "scan_yaw_deg": 45.0, "tau_left": 0.9}

# The protocol is data, written into frozen_v2.json and hashed together with the config.
PROTOCOL = {
    "version": "v2",
    "split_ids": {"v2_val": 3, "v2_final": 4},
    "seed_policy": "numpy SeedSequence([base_seed, scenario_idx, split_id, episode_idx]); "
                   "v1 used split ids dev=0, val=1, test=2; v2 uses v2_val=3 and v2_final=4 only",
    "tuning": {
        "policy": "belief",
        "scenarios": ["A_matched", "B_motion_mismatch"],
        "split": "v2_val",
        "n_per_scenario": 100,
        "lam_grid": [0.0005, 0.001, 0.002, 0.004],
        "tolerance": 0.03,
        "rule": "select the largest lam whose combined (A+B) reacquired-by-deadline fraction is within "
                "0.03 absolute of the best fraction on the grid; lam = 0 is not a candidate",
    },
    "final": {
        "split": "v2_final",
        "n_per_scenario": 200,
        "scenarios": [s.name for s in SCENARIOS],
        "policies": list(POLICIES),
        "reference_arms": [REFERENCE_ARM],
        "reference_arm_note": "belief_lam0 = BeliefView with lam = 0 on the same final episodes; a labelled paired "
                              "reference arm only, never a tuning candidate or a replacement headline",
        "exit_sweep": {"scenario": "D_exit_mismatch", "policy": "belief"},
        "runs_allowed": 1,
    },
    "fixed_from_v1_not_retuned": dict(FIXED_FROM_V1),
    "ablation": "belief_noneg inherits the selected lam and every other planner setting; nothing is tuned for it",
    "after_final": "any substantive correction after viewing v2 final results requires a separately labelled v3 and new seeds",
}

# Modules that determine what an episode run produces. Their checksum is frozen with the config.
CORE_MODULES = ["config.py", "geometry.py", "sensor.py", "belief.py", "dynamics.py", "planner.py", "policies.py",
                "world.py", "runner.py", "experiment.py", "v2.py"]
# Reporting code (tables, figures, animations, demo) only reads saved records; it may be corrected
# after the final run without touching the frozen core, and its checksum is logged separately.
REPORT_MODULES = ["analysis.py", "plots.py", "animate.py", "cli.py", "v2_report.py", "demo.py"]


def source_checksum(modules) -> str:
    h = hashlib.sha256()
    for name in modules:
        h.update(name.encode() + b"\0" + (ROOT / "beliefview" / name).read_bytes() + b"\0")
    return h.hexdigest()[:16]


def git_revision() -> str:
    try:
        rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "beliefview"], cwd=ROOT, capture_output=True,
                               text=True).stdout.strip()
        return f"{rev or 'unknown'}{' + uncommitted changes in beliefview/' if dirty else ''}"
    except OSError:
        return "unknown"


def protocol_hash(cfg) -> str:
    s = json.dumps({"config": to_jsonable(cfg), "protocol": PROTOCOL}, sort_keys=True)
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def _now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- selection rule (pure)
def select_lam(candidates: dict, tolerance: float) -> float:
    """candidates: {lam: {"n_found": int, "n": int, ...}} -> the largest lam within `tolerance`
    (absolute, on the combined reacquired fraction) of the best candidate."""
    frac = {float(lam): c["n_found"] / c["n"] for lam, c in candidates.items()}
    assert all(lam > 0 for lam in frac), "lam = 0 is not a v2 tuning candidate"
    best = max(frac.values())
    return max(lam for lam, f in frac.items() if best - f <= tolerance + 1e-12)


# ---------------------------------------------------------------- tuning + freeze
def tune_v2(workers=None, split=None, n=None, out_dir=V2_DIR):
    """`split`/`n`/`out_dir` are overridden only by the dev-split smoke test."""
    tp = PROTOCOL["tuning"]
    split, n = split or tp["split"], n or tp["n_per_scenario"]
    T = build_config().experiment.deadline
    cands, all_recs = {}, []
    for lam in tp["lam_grid"]:
        cfg = build_config({**FIXED_FROM_V1, "lam": lam})
        recs = run_tasks(cfg, tasks_for(tp["scenarios"], split, n, [tp["policy"]]), workers, f"v2 tune lam={lam:g}")
        assert all(r["planner_lam"] == lam and r["split"] == split for r in recs)
        all_recs += recs
        row = {"n": len(recs), "n_found": int(sum(r["found"] for r in recs)),
               "found_by_deadline": sum(r["found"] for r in recs) / len(recs),
               "mean_distance": float(np.mean([r["distance"] for r in recs])),
               "rmst": float(np.mean([r["t_detect"] if r["found"] else T for r in recs]))}
        for sc in tp["scenarios"]:
            rs = [r for r in recs if r["scenario"] == sc]
            row[sc] = {"n": len(rs), "n_found": int(sum(r["found"] for r in rs)),
                       "found_by_deadline": sum(r["found"] for r in rs) / len(rs),
                       "mean_distance": float(np.mean([r["distance"] for r in rs]))}
        cands[lam] = row
        print(f"  v2 tune lam={lam:g}: found={row['found_by_deadline']:.3f} ({row['n_found']}/{row['n']}) "
              f"dist={row['mean_distance']:.1f}", flush=True)
    selected = select_lam(cands, tp["tolerance"])
    best = max(c["found_by_deadline"] for c in cands.values())
    out_dir.mkdir(parents=True, exist_ok=True)
    save_records(all_recs, out_dir / "validation_records.jsonl")
    log = {"candidates": {f"{lam:g}": c for lam, c in cands.items()}, "best_found_by_deadline": best,
           "tolerance": tp["tolerance"],
           "eligible": [lam for lam, c in cands.items() if best - c["found_by_deadline"] <= tp["tolerance"] + 1e-12],
           "selected_lam": selected, "split": split, "n_per_scenario": n,
           "note": "Validation split only. Every candidate ran the same validation episodes (paired). Only the "
                   "BeliefView planner was run; the no-miss-update ablation inherits the selected lam. Orbit margin, "
                   "scan yaw and tau_left are the v1 values and were not re-tuned."}
    return {"chosen": {"lam": selected, **FIXED_FROM_V1}, "log": log}


def freeze_v2(tuned: dict, path=FROZEN_V2) -> dict:
    if Path(path).exists():
        raise SystemExit(f"{path} already exists: v2 is frozen. It is not re-tuned or re-frozen.")
    cfg = build_config(tuned["chosen"])
    d = {"version": "v2", "frozen_at": _now(), "chosen": tuned["chosen"],
         "config_hash": config_hash(cfg), "protocol_hash": protocol_hash(cfg),
         "core_source_checksum": source_checksum(CORE_MODULES), "core_source_modules": CORE_MODULES,
         "git_revision_at_freeze": git_revision(),
         "protocol": PROTOCOL, "base_seed": cfg.experiment.base_seed,
         "note": "config.experiment.n_dev/n_val/n_test are v1 fields and are unused by v2; the v2 episode counts "
                 "are protocol.tuning.n_per_scenario and protocol.final.n_per_scenario. config_hash covers the "
                 "config block (same function as v1); protocol_hash covers config + protocol.",
         "config": to_jsonable(cfg), "tuning_log": tuned["log"]}
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(d, indent=2, default=float) + "\n")
    return d


def load_frozen_v2(path=FROZEN_V2) -> dict:
    if not Path(path).exists():
        raise SystemExit(f"{path} not found: run `python -m beliefview.cli v2-tune` first.")
    return json.loads(Path(path).read_text())


def verify_frozen_v2(frozen: dict, check_source=True):
    cfg = build_config(frozen["chosen"])
    if frozen["protocol"] != json.loads(json.dumps(PROTOCOL)):
        raise SystemExit("The v2 protocol in the code differs from the frozen one. Any change needs a labelled v3.")
    if config_hash(cfg) != frozen["config_hash"] or protocol_hash(cfg) != frozen["protocol_hash"]:
        raise SystemExit("v2 config/protocol hash mismatch: settings changed after freezing. That needs a labelled v3.")
    if check_source and source_checksum(CORE_MODULES) != frozen["core_source_checksum"]:
        raise SystemExit("Simulation/inference source changed after the v2 freeze (core_source_checksum mismatch). "
                         "A substantive change needs a labelled v3 and new seeds.")
    assert cfg.planner.lam > 0 and cfg.planner.lam in PROTOCOL["tuning"]["lam_grid"]
    assert {k: SPLITS[k] for k in ("v2_val", "v2_final")} == PROTOCOL["split_ids"]
    return cfg


def cmd_tune(args):
    if FROZEN_V2.exists():
        raise SystemExit(f"{FROZEN_V2} already exists: v2 is frozen and is not re-tuned.")
    t0 = time.time()
    d = freeze_v2(tune_v2(args.workers))
    print(f"v2 frozen: lam={d['chosen']['lam']:g} config {d['config_hash']} protocol {d['protocol_hash']} "
          f"source {d['core_source_checksum']} ({time.time() - t0:.0f}s)")


# ---------------------------------------------------------------- the final run
def _final_tasks(cfg, split, n):
    fp = PROTOCOL["final"]
    main = tasks_for(fp["scenarios"], split, n, FINAL_POLICIES)
    sweep = {h: tasks_for([fp["exit_sweep"]["scenario"]], split, n, [fp["exit_sweep"]["policy"]], assumed_exit=h)
             for h in cfg.experiment.exit_sweep}
    return main, sweep


def run_final_episodes(cfg, workers, split, n, out_dir):
    main, sweep = _final_tasks(cfg, split, n)
    recs = run_tasks(cfg, main, workers, "v2 final")
    save_records(recs, out_dir / "final_records.jsonl")
    srecs = []
    for h, tasks in sweep.items():
        srecs += run_tasks(cfg, tasks, workers, f"v2 exit={h}")
    save_records(srecs, out_dir / "exit_sweep_records.jsonl")
    return recs, srecs


def _key(r):
    return (r["scenario"], r["idx"], r["policy"], r["assumed_exit"])


def cmd_final(args):
    frozen = load_frozen_v2()
    cfg = verify_frozen_v2(frozen)
    fp = PROTOCOL["final"]
    if args.repro_check:
        return _repro_check(cfg, frozen, args.workers)
    if LOCK.exists():
        raise SystemExit(
            f"{LOCK} exists: the one v2 final run has already been started ({json.loads(LOCK.read_text()).get('started_at')}).\n"
            "A second inferential run is not allowed. Use `v2-report` to rebuild tables from the saved records, or "
            "`v2-final --repro-check` for a labelled reproducibility check. Anything else needs a labelled v3 and new seeds.")
    V2_DIR.mkdir(parents=True, exist_ok=True)
    lock = {"what": "Marks the single v2 final (inferential) run. Written BEFORE the first final episode is generated.",
            "started_at": _now(), "protocol_hash": frozen["protocol_hash"], "config_hash": frozen["config_hash"],
            "core_source_checksum": source_checksum(CORE_MODULES), "git_revision": git_revision(),
            "split": fp["split"], "split_id": SPLITS[fp["split"]], "n_per_scenario": fp["n_per_scenario"],
            "completed_at": None}
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    t0 = time.time()
    run_final_episodes(cfg, args.workers, fp["split"], fp["n_per_scenario"], V2_DIR)
    lock.update(completed_at=_now(), episode_wall_seconds=round(time.time() - t0))
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    from .v2_report import build_report   # reporting reads the saved records; it is not part of the frozen core
    build_report()
    print(f"v2 final run done in {time.time() - t0:.0f}s; results in {V2_DIR}")


def _repro_check(cfg, frozen, workers):
    """Deliberate reproducibility check. Re-runs the frozen final protocol into results/v2/repro_check/
    and compares every record with the recorded run. No headline artifact is touched; no new inference."""
    if not (LOCK.exists() and json.loads(LOCK.read_text()).get("completed_at")):
        raise SystemExit("No completed v2 final run to check against.")
    fp = PROTOCOL["final"]
    out = V2_DIR / "repro_check"
    out.mkdir(exist_ok=True)
    t0 = time.time()
    recs, srecs = run_final_episodes(cfg, workers, fp["split"], fp["n_per_scenario"], out)
    lines = ["# v2 REPRODUCIBILITY CHECK (not an inferential run)\n",
             f"- run at {_now()}; protocol hash `{frozen['protocol_hash']}`; core source checksum `{source_checksum(CORE_MODULES)}`",
             "- This re-ran the frozen v2 final protocol on the same split id 4 episodes only to check that the recorded "
             "per-episode records are reproduced. It changes no headline table and supports no new claim."]
    ok = True
    for name, new in (("final_records.jsonl", recs), ("exit_sweep_records.jsonl", srecs)):
        old = {_key(r): r for r in load_records(V2_DIR / name)}
        newd = {_key(json.loads(json.dumps(r, default=float))): json.loads(json.dumps(r, default=float)) for r in new}
        diff = [k for k in sorted(set(old) | set(newd), key=str) if old.get(k) != newd.get(k)]
        ok &= not diff
        lines.append(f"- `{name}`: {len(newd)} records re-run, {len(diff)} differ from the recorded run"
                     + (f" (first: {diff[:3]})" if diff else " (identical)"))
    lines.append(f"- verdict: {'REPRODUCED' if ok else 'NOT REPRODUCED'}; wall time {time.time() - t0:.0f}s")
    (out / "REPRO_CHECK.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
