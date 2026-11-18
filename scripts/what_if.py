"""Scratch what-if on the DEV split (never a validation, test or final split; does not touch frozen results).
Uses the frozen v2 settings by default (`--config v1` for the earlier lam = 0 record).

  .venv/bin/python scripts/what_if.py --scenario B_motion_mismatch --n 20 --set assumed_motion.p_stop=0.1
  settable groups: assumed_motion.*, assumed_sensor.*, true_sensor.*, truth_motion.*
"""
import argparse
import dataclasses
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from beliefview.experiment import POLICIES, SCEN_INDEX, SCENARIOS, build_config, load_frozen, run_tasks, tasks_for


def apply(spec, assignments):
    for a in assignments:
        key, val = a.split("=")
        group, field = key.split(".")
        obj = getattr(spec, group)
        cur = getattr(obj, field)
        spec = dataclasses.replace(spec, **{group: dataclasses.replace(obj, **{field: type(cur)(float(val))})})
    return spec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="A_matched")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--set", nargs="*", default=[])
    ap.add_argument("--config", choices=["v2", "v1"], default="v2")
    a = ap.parse_args()
    if a.config == "v2":
        from beliefview.v2 import load_frozen_v2
        cfg = build_config(load_frozen_v2()["chosen"])
    else:
        cfg = build_config(load_frozen()["chosen"])
    print(f"{a.config} settings, lam = {cfg.planner.lam:g}; dev split only")
    for label, assigns in (("baseline", []), ("what-if", a.set)):
        scen = tuple(apply(s, assigns) if s.name == a.scenario else s for s in cfg.scenarios)
        c = dataclasses.replace(cfg, scenarios=scen)
        recs = run_tasks(c, tasks_for([a.scenario], "dev", a.n, POLICIES), None, label)
        print(f"\n== {label} {assigns} ({a.scenario}, dev split, n={a.n}) ==")
        for p in POLICIES:
            rs = [r for r in recs if r["policy"] == p]
            print(f"  {p:13s} reacquired by deadline {np.mean([r['found'] for r in rs]):.2f}   "
                  f"mean travel {np.mean([r['distance'] for r in rs]):.1f}")


if __name__ == "__main__":
    main()
