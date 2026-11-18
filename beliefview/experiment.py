"""Scenarios, policy factory, parallel episode execution, tuning and frozen-config check."""
from __future__ import annotations

import dataclasses
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional

from .belief import GridGeometry
from .config import (BaselineParams, ExperimentConfig, FrozenConfig, MapConfig, MotionAssumption, ObserverDyn,
                     PlannerParams, ScenarioSpec, SensorParams, TruthMotion, config_hash, to_jsonable)
from .dynamics import Navigator
from .policies import (BeliefNoNegPolicy, BeliefPolicy, LastSeenPolicy, OrbitPolicy, StayPolicy)
from .runner import run_episode
from .world import make_episode

ROOT = Path(__file__).resolve().parent.parent
POLICIES = ["stay", "last_seen", "orbit", "belief", "belief_noneg"]

_A_BEHAV = (("continue", 0.30), ("turn", 0.25), ("stop", 0.20), ("conceal", 0.15), ("exit", 0.10))
SCENARIOS = (
    ScenarioSpec("A_matched", "Assumptions approximately right (same speed, stop/turn rates, sensor).",
                 TruthMotion(), SensorParams()),
    ScenarioSpec("B_motion_mismatch",
                 "Structural motion mismatch: long stops (50-120 steps) and doubling back; filter still assumes short stops, rare reversals.",
                 TruthMotion(behavior_probs=(("continue", 0.10), ("turn", 0.10), ("stop", 0.30),
                                             ("doubleback", 0.25), ("conceal", 0.15), ("exit", 0.10)),
                             stop_dur=(50, 120)), SensorParams()),
    ScenarioSpec("C_sensor_mismatch",
                 "Sensor mismatch: true foliage detection 0.10x (assumed 0.4x), true p0 0.75 (assumed 0.9), true range scale 7 (assumed 6, i.e. true range is better), true meas. noise 1.0 (assumed 0.6).",
                 TruthMotion(), SensorParams(p0=0.75, foliage_factor=0.10, r0=7.0, meas_sigma=1.0),
                 assumed_sensor=SensorParams(meas_sigma=0.6)),
    ScenarioSpec("D_exit_mismatch",
                 "Exit-heavy truth (35% exit behaviour, true boundary hazard 0.08/step) vs assumed 0.03; used for the exit-rate sweep.",
                 TruthMotion(behavior_probs=(("continue", 0.20), ("turn", 0.15), ("stop", 0.10),
                                             ("conceal", 0.20), ("exit", 0.35)), edge_exit_rate=0.08),
                 SensorParams()),
)
SCEN_INDEX = {s.name: i for i, s in enumerate(SCENARIOS)}

# `lam` is the ONE travel penalty used by BeliefView and by its no-miss-update ablation.
TUNABLE_DEFAULTS = {"lam": 0.001, "orbit_margin": 3.0, "scan_yaw_deg": 30.0, "tau_left": 0.5}


def build_config(chosen: Optional[dict] = None) -> FrozenConfig:
    c = dict(TUNABLE_DEFAULTS)
    unknown = set(chosen or {}) - set(c)
    if unknown:  # e.g. a stale frozen.json with separately tuned ablation settings
        raise SystemExit(f"Unknown tunable(s) {sorted(unknown)}: re-run `make tune` (validation only) to re-freeze.")
    c.update(chosen or {})
    return FrozenConfig(
        map=MapConfig(),
        observer=ObserverDyn(scan_yaw_deg=c["scan_yaw_deg"]),
        experiment=ExperimentConfig(tau_left=c["tau_left"]),
        planner=PlannerParams(lam=c["lam"]),
        baselines=BaselineParams(orbit_margin=c["orbit_margin"], scan_yaw_deg=c["scan_yaw_deg"]),
        scenarios=SCENARIOS,
    )


V1_FROZEN = ROOT / "config" / "frozen.json"   # the v1 record (hash 222bce7e37097894); never rewritten


def load_frozen(path: Optional[Path] = None) -> dict:
    """The v1 frozen config by default. The v2 frozen protocol lives in `v2.py`."""
    return json.loads(Path(path or V1_FROZEN).read_text())


def verify_frozen(cfg: FrozenConfig, frozen: dict) -> None:
    h = config_hash(cfg)
    if h != frozen["config_hash"]:
        raise SystemExit(f"Config hash {h} != frozen {frozen['config_hash']}: settings changed after freezing. "
                         "Re-run `make tune` (validation only) to re-freeze.")


# ---------------------------------------------------------------- policy factory
def make_policy(name: str, cfg: FrozenConfig, spec: ScenarioSpec, geo, nav, assumed_exit: Optional[float] = None):
    mo = spec.assumed_motion
    if assumed_exit is not None:
        mo = dataclasses.replace(mo, edge_exit_rate=assumed_exit)
    se = spec.assumed_sensor
    if name == "stay":
        return StayPolicy(geo, nav, mo, se)
    if name == "last_seen":
        return LastSeenPolicy(geo, nav, mo, se)
    if name == "orbit":
        return OrbitPolicy(geo, nav, mo, se, bp=cfg.baselines)
    # Clean ablation: both planner policies get the SAME PlannerParams object (candidate
    # set, horizon, commit length, travel penalty) and the same controller/navigator. They
    # differ only in BeliefNoNegPolicy.skip_miss (miss observations do not update belief).
    if name == "belief":
        return BeliefPolicy(geo, nav, mo, se, pp=cfg.planner)
    if name == "belief_noneg":
        return BeliefNoNegPolicy(geo, nav, mo, se, pp=cfg.planner)
    # v2 reference arm only: BeliefView with the travel penalty switched off, every other
    # planner setting identical. Never a tuning candidate and never the headline.
    if name == "belief_lam0":
        p = BeliefPolicy(geo, nav, mo, se, pp=dataclasses.replace(cfg.planner, lam=0.0))
        p.name = "belief_lam0"
        return p
    raise ValueError(name)


# ---------------------------------------------------------------- parallel execution
_CTX = {}


def _init(cfg):
    _CTX["cfg"] = cfg
    _CTX["geo"] = GridGeometry(cfg.map)
    _CTX["nav"] = Navigator(cfg.map, cfg.observer)


def _work(task):
    scen, split, idx, pol, assumed_exit = task
    cfg, geo, nav = _CTX["cfg"], _CTX["geo"], _CTX["nav"]
    spec = cfg.scenarios[SCEN_INDEX[scen]]
    ep = make_episode(spec, SCEN_INDEX[scen], split, idx, cfg.experiment.base_seed, cfg.map, nav, cfg.experiment.deadline)
    p = make_policy(pol, cfg, spec, geo, nav, assumed_exit)
    rec = run_episode(ep, p, spec, cfg.map, nav, cfg.experiment)
    rec["assumed_exit"] = assumed_exit
    pp = getattr(p, "pp", None)   # travel penalty this run actually used (None for non-planner policies)
    rec["planner_lam"] = None if pp is None else pp.lam
    return rec


def run_tasks(cfg: FrozenConfig, tasks: List[tuple], workers: Optional[int] = None, label: str = "") -> List[dict]:
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    t0 = time.time()
    out = []
    with ProcessPoolExecutor(max_workers=workers, initializer=_init, initargs=(cfg,)) as ex:
        for i, r in enumerate(ex.map(_work, tasks, chunksize=2)):
            out.append(r)
            if (i + 1) % 100 == 0:
                print(f"  [{label}] {i + 1}/{len(tasks)} episodes-runs, {time.time() - t0:.0f}s", flush=True)
    print(f"  [{label}] done {len(tasks)} runs in {time.time() - t0:.0f}s", flush=True)
    return out


def tasks_for(scenarios, split, n, policies, assumed_exit=None):
    return [(s, split, i, p, assumed_exit) for s in scenarios for i in range(n) for p in policies]


def save_records(recs, path):
    with open(path, "w") as f:
        for r in recs:
            f.write(json.dumps(r, default=float) + "\n")


def load_records(path):
    return [json.loads(l) for l in open(path)]


# ---------------------------------------------------------------- tuning (validation split ONLY)
def _score(recs):
    n = len(recs)
    found = sum(r["found"] for r in recs) / n
    dist = sum(r["distance"] for r in recs) / n
    return found, dist


def tune(workers=None) -> dict:
    base = build_config()
    exp = base.experiment
    n = exp.n_val
    scen_ab = ["A_matched", "B_motion_mismatch"]
    log = {"grids": {}}
    chosen = {}

    def run_variant(chosen_over, policies, scen=scen_ab, label=""):
        cfg = build_config({**chosen, **chosen_over})
        return run_tasks(cfg, tasks_for(scen, "val", n, policies), workers, label)

    def pick(key, values, policy):
        res = {}
        for v in values:
            recs = run_variant({key: v}, [policy], label=f"{policy} {key}={v}")
            f, d = _score(recs)
            res[v] = {"found_by_deadline": f, "mean_distance": d, "n": len(recs)}
            print(f"  tune {policy} {key}={v}: found={f:.3f} dist={d:.1f}", flush=True)
        best = max(values, key=lambda v: (round(res[v]["found_by_deadline"], 4), -res[v]["mean_distance"]))
        log["grids"][f"{policy}:{key}"] = res
        chosen[key] = best
        return best

    # One travel penalty, tuned on the BeliefView planner only. The no-miss-update ablation is
    # NOT tuned separately: it inherits this value, so the ablation differs from BeliefView
    # only in whether misses update the belief.
    pick("lam", [0.0, 0.0005, 0.002], "belief")
    pick("orbit_margin", [2.0, 4.0], "orbit")
    # scan yaw is shared by stay and last_seen: choose by their mean found fraction
    res = {}
    for v in [20.0, 45.0]:
        recs = run_variant({"scan_yaw_deg": v}, ["stay", "last_seen"], label=f"scan {v}")
        res[v] = {"found_by_deadline": _score(recs)[0], "mean_distance": _score(recs)[1], "n": len(recs)}
    log["grids"]["stay+last_seen:scan_yaw_deg"] = res
    chosen["scan_yaw_deg"] = max(res, key=lambda v: res[v]["found_by_deadline"])

    # tau_left: choose on validation A,B,D using the belief planner's final belief
    recs = run_variant({}, ["belief"], scen=scen_ab + ["D_exit_mismatch"], label="belief tau")
    un = [r for r in recs if not r["found"]]
    tau_res = {}
    for tau in [0.3, 0.5, 0.7, 0.9]:
        tl = [r for r in un if r["truth_left"]]
        ti = [r for r in un if not r["truth_left"]]
        tpr = sum(r["p_out"] >= tau for r in tl) / max(1, len(tl))
        fpr = sum(r["p_out"] >= tau for r in ti) / max(1, len(ti))
        tau_res[tau] = {"correct_left_rate": tpr, "false_left_rate": fpr, "youden": tpr - fpr,
                        "n_truth_left": len(tl), "n_truth_inside": len(ti)}
    log["grids"]["belief:tau_left"] = tau_res
    chosen["tau_left"] = max(tau_res, key=lambda t: (round(tau_res[t]["youden"], 4), -t))
    log["note"] = ("All tuning used split='val' only (disjoint from 'test'). No early-stop rule exists in v1, "
                   "so there are no wrongful early stops; tau_left only affects the deadline 'left the area' report. "
                   "The no-miss-update ablation has no tuned parameter of its own: it shares `lam` and every "
                   "other planner setting with BeliefView.")
    log["chosen"] = chosen
    return {"chosen": chosen, "log": log}


def freeze(tuned: dict, path: Optional[Path] = None) -> dict:
    """Write a v1-style frozen file. `path` must be given: the v1 record is never rewritten."""
    if path is None or Path(path).resolve() == V1_FROZEN.resolve():
        raise SystemExit("Refusing to rewrite the v1 record config/frozen.json; pass a reproduction path.")
    cfg = build_config(tuned["chosen"])
    d = {"chosen": tuned["chosen"], "config_hash": config_hash(cfg), "config": to_jsonable(cfg),
         "tuning_log": tuned["log"],
         "seed_policy": "numpy SeedSequence([base_seed, scenario_idx, split_id, episode_idx]); split ids dev=0, val=1, test=2"}
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(d, indent=2, default=float))
    return d
