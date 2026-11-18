"""Print the candidate table behind one planner decision (dev split by default).

  .venv/bin/python scripts/explain_decision.py --scenario A_matched --idx 0 --t 4
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

import beliefview.experiment as E
from beliefview.runner import run_episode
from beliefview.world import make_episode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="A_matched")
    ap.add_argument("--split", default="dev")
    ap.add_argument("--idx", type=int, default=0)
    ap.add_argument("--t", type=int, default=1, help="a step at which the planner re-plans (1,4,7,...)")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--config", choices=["v2", "v1"], default="v2",
                    help="v2 = frozen v2 settings (positive lam, headline); v1 = earlier record (lam = 0)")
    a = ap.parse_args()
    if a.config == "v2":
        from beliefview.v2 import load_frozen_v2
        cfg = E.build_config(load_frozen_v2()["chosen"])
    else:
        cfg = E.build_config(E.load_frozen()["chosen"])
    E._init(cfg)
    geo, nav = E._CTX["geo"], E._CTX["nav"]
    spec = cfg.scenarios[E.SCEN_INDEX[a.scenario]]
    ep = make_episode(spec, E.SCEN_INDEX[a.scenario], a.split, a.idx, cfg.experiment.base_seed, cfg.map, nav, cfg.experiment.deadline)
    pol = E.make_policy("belief", cfg, spec, geo, nav)
    tr = []
    run_episode(ep, pol, spec, cfg.map, nav, cfg.experiment, trace=tr)
    f = next((x for x in tr if x["decision"] and x["decision"]["t"] == a.t), None)
    if f is None:
        ts = sorted({x["decision"]["t"] for x in tr if x["decision"]})
        sys.exit(f"no planning decision at t={a.t}; planning steps in this run: {ts}")
    d = f["decision"]
    print(f"{a.scenario} {a.split} ep {a.idx}, planning at t={a.t}; {a.config} settings, lam={cfg.planner.lam:g}")
    print("score = P(reacquire within horizon) - lam * travel_steps   (greedy: best single candidate)")
    print(f"{'label':12s} {'goal':>14s} {'reach':>5s} {'travel':>6s} {'gain':>7s} {'score':>8s}")
    for c in sorted(d["cands"], key=lambda c: -c.score)[: a.top]:
        mark = "  <- chosen" if c is d["chosen"] else ""
        print(f"{c.label:12s} ({c.goal[0]:5.1f},{c.goal[1]:5.1f}) {str(c.reachable):>5s} {c.travel_steps:6d} {c.gain:7.4f} {c.score:8.4f}{mark}")


if __name__ == "__main__":
    main()
