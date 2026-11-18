"""Command line.

v2 (headline):  `v2-tune` (validation split id 3, freezes config/frozen_v2.json), `v2-final` (one run on
                split id 4; refuses a second inferential run; `--repro-check` is a labelled reproducibility
                check), `v2-report` (rebuild tables/figures/animations/demo from the saved records), `demo`.
v1 (earlier record): `tune` / `test` reproduce the v1 run into results/v1_repro/ by default. They never write
                to config/frozen.json, results/ top level, or archive/v1/.
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np

from . import __version__
from .analysis import (POL_LABEL, BEHAVIORS, behavior_split, exit_sweep, md_table, summarize, write_csv)
from .belief import GridGeometry
from .dynamics import Navigator
from .experiment import (POLICIES, ROOT, SCEN_INDEX, SCENARIOS, build_config, freeze, load_frozen, make_policy,
                         run_tasks, save_records, tasks_for, tune, verify_frozen)
from .runner import run_episode
from .world import make_episode

RES = ROOT / "results"            # top level = the v1 record (never rewritten by any command)
V1_REPRO = RES / "v1_repro"       # default output of the v1 reproduction commands


def _v1_out(args) -> Path:
    """Output directory of a v1 reproduction: results/v1_repro/ (the default) or a directory beneath it.
    Anything else (results/ itself, results/v2/, archive/, config/, or a path outside the project) is
    refused before a directory is created or a file is written."""
    base = V1_REPRO.resolve()
    out = Path(args.out).resolve() if args.out else base
    if out != base and base not in out.parents:
        raise SystemExit(f"Refusing to write a v1 reproduction into {out}: --out must be {base} or a directory "
                         f"inside it, so that no other project record can be overwritten.")
    out.mkdir(parents=True, exist_ok=True)
    return out


def cmd_tune(args):
    """v1 validation tuning, reproduction only: writes <out>/frozen.json, never config/frozen.json."""
    t0 = time.time()
    out = _v1_out(args)
    tuned = tune(args.workers)
    d = freeze(tuned, out / "frozen.json")
    print("v1 REPRODUCTION. Chosen (validation only):", d["chosen"], "hash", d["config_hash"],
          f"{time.time() - t0:.0f}s; wrote {out / 'frozen.json'}")


def pick_animation_episodes(recs, cfg):
    A = [r for r in recs if r["scenario"] == "A_matched" and r["policy"] == "belief" and r["found"]]
    ts = sorted(r["t_detect"] for r in A)
    med = ts[len(ts) // 2]
    succ = min(A, key=lambda r: (abs(r["t_detect"] - med), r["idx"]))
    fails = [r for r in recs if r["policy"] == "belief" and not r["found"] and r["exit_step"] is None]
    pref = [r for r in fails if r["scenario"] == "B_motion_mismatch"] or fails
    fail = min(pref, key=lambda r: (SCEN_INDEX[r["scenario"]], r["idx"]))
    return succ, fail


ANIM_FPS = 6


def make_animations(recs, cfg, res=RES, split="test", ep_word="test", extra_args=None, meta=None):
    """Replay two recorded BeliefView episodes for rendering. `meta` (a list) collects per-frame
    numbers for the local demo. The replay is deterministic and is checked against the record."""
    from .animate import render
    geo, nav = GridGeometry(cfg.map), Navigator(cfg.map, cfg.observer)
    succ, fail = pick_animation_episodes(recs, cfg)
    outs = []
    for kind, r in (("representative", succ), ("failure", fail)):
        spec = cfg.scenarios[SCEN_INDEX[r["scenario"]]]
        ep = make_episode(spec, SCEN_INDEX[spec.name], split, r["idx"], cfg.experiment.base_seed, cfg.map, nav,
                          cfg.experiment.deadline)
        pol = make_policy("belief", cfg, spec, geo, nav)
        tr = []
        rr = run_episode(ep, pol, spec, cfg.map, nav, cfg.experiment, trace=tr)
        assert rr["found"] == r["found"], "animation replay differs from recorded run"
        what = (f"found at t={rr['t_detect']}" if rr["found"] else f"NOT reacquired by deadline (P(outside)={rr['p_out']:.2f})")
        title = f"{kind}: {spec.name}, {ep_word} ep {r['idx']}; {what}\ntrue behaviour = {ep.behavior} (evaluation-only ground truth)"
        path = render(tr, cfg.map, spec.true_sensor, None, str(res / f"animation_{kind}.mp4"), title, fps=ANIM_FPS,
                      extra_args=extra_args)
        outs.append((kind, spec.name, r["idx"], ep.behavior, what, path))
        if meta is not None:
            assert rr["t_detect"] == r["t_detect"] and abs(rr["distance"] - r["distance"]) < 1e-9
            meta.append(dict(kind=kind, file=Path(path).name, scenario=spec.name, split=split, idx=r["idx"],
                             behavior=ep.behavior, found=bool(rr["found"]), t_detect=rr["t_detect"],
                             p_out_final=rr.get("p_out"), truth_left=rr.get("truth_left"),
                             declared_left=rr.get("declared_left"), distance=rr["distance"],
                             planner_lam=pol.pp.lam, fps=ANIM_FPS, n_frames=len(tr),
                             frames=[dict(t=f["t"], p_out=round(float(f["out"]), 4), look=bool(f["look"]),
                                          detected=bool(f["detected"]), subject_inside=f["subject"] is not None)
                                     for f in tr]))
    return outs


def cmd_test(args):
    """v1 run with the v1 frozen config on the v1 test split. Since v2 this is a REPRODUCTION of the
    earlier record: it writes to results/v1_repro/ (or --out) and never to the v1 record itself."""
    from .plots import comparison_figure, exit_sweep_figure, map_figure
    t0 = time.time()
    out = _v1_out(args)
    print(f"v1 REPRODUCTION (config/frozen.json, v1 test split). Output: {out}")
    frozen = load_frozen()
    cfg = build_config(frozen["chosen"])
    verify_frozen(cfg, frozen)
    exp = cfg.experiment
    n = args.n or exp.n_test
    T = exp.deadline
    names = [s.name for s in SCENARIOS]
    recs = run_tasks(cfg, tasks_for(names, "test", n, POLICIES), args.workers, "main")
    save_records(recs, out / "test_records.jsonl")
    sweep = {}
    for h in exp.exit_sweep:
        rs = run_tasks(cfg, tasks_for(["D_exit_mismatch"], "test", n, ["belief"], assumed_exit=h), args.workers, f"exit={h}")
        sweep[h] = rs
    save_records([r for rs in sweep.values() for r in rs], out / "exit_sweep_records.jsonl")

    rows, diffs, curves = summarize(recs, T, exp.bootstrap)
    bsplit = behavior_split(recs)
    swrows = exit_sweep(sweep, T, exp.bootstrap)
    write_csv(rows, out / "summary_by_scenario.csv")
    write_csv(diffs, out / "paired_differences.csv")
    write_csv(bsplit, out / "behavior_split.csv")
    write_csv(swrows, out / "exit_rate_sensitivity.csv")
    np.savez(out / "curves.npz", **{f"{s}|{p}": v for (s, p), v in curves.items()})

    comparison_figure(rows, diffs, curves, T, names, out / "comparison.png", n_note=f"N={n} per scenario.")
    exit_sweep_figure(swrows, out / "exit_rate_sensitivity.png", SCENARIOS[SCEN_INDEX["D_exit_mismatch"]].truth_motion.edge_exit_rate)
    map_figure(cfg.map, out / "map.png")
    anims = make_animations(recs, cfg, res=out)
    write_results_md(rows, diffs, bsplit, swrows, cfg, n, anims, frozen, res=out)
    write_log(cfg, frozen, n, time.time() - t0, rows, anims, res=out)
    print(f"Wrote results to {out} in {time.time() - t0:.0f}s")


PAIRING_NOTE = (
    "**What is paired.** Every policy runs the same pre-rolled episodes: identical subject trajectory, behaviour, "
    "observer start, noisy last-seen measurement and its age, deadline, sensor, look gate and controller. The "
    "detection uniform `u[t]` and the measurement noise are pre-drawn per time step and shared (common random "
    "numbers). A detection at step t happens when that step is a new look and `u[t] < P(detect | this policy's "
    "viewpoint)`, so policies at different viewpoints do **not** receive identical observations; only the draws "
    "are shared. The simulated sensor has no false positives.\n")


def _region_cols():
    return [("policy", lambda r: POL_LABEL[r["policy"]]),
            ("unresolved n", "n_unresolved"),
            ("mean P(outside)", "mean_p_out"),
            ("region area (cells of 1600)", lambda r: f"{r['region_area']:.0f}"),
            ("region mass given inside", "region_cond_mass"),
            ("region mass, unconditional", "region_uncond_mass"),
            ("subject still inside (n)", "region_cov_n"),
            ("of those, inside region", lambda r: f"{r['region_cov_k']} of {r['region_cov_n']}")]


def write_results_md(rows, diffs, bsplit, swrows, cfg, n, anims, frozen, *, res=RES, policies=POLICIES,
                     head=None, after_primary=None, ep_word="test"):
    """`head`, `after_primary`, `policies` and `ep_word` are used by the v2 report; the defaults
    reproduce the v1 report text exactly."""
    T = cfg.experiment.deadline
    pct = round(100 * cfg.experiment.credible_mass)
    L = list(head) if head is not None else [
         f"# Results (auto-generated by `python -m beliefview.cli test`)\n",
         f"Synthetic 2D simulation. N = {n} held-out test episodes per scenario, paired across policies. Deadline T = {T} steps. "
         f"Config hash `{frozen['config_hash']}`. Intervals are 95% percentile bootstrap over episodes (B={cfg.experiment.bootstrap}).\n"]
    L += [PAIRING_NOTE,
         "## Primary comparison: clean no-miss-update ablation\n",
         f"BeliefView and the ablation use the same planner settings object (candidate set, horizon {cfg.planner.horizon}, "
         f"commit {cfg.planner.commit}, travel penalty lam = {cfg.planner.lam:g}), the same controller and the same episodes. "
         "The only difference is whether a missed detection updates the belief. Differences are BeliefView minus ablation: "
         "`d_found` > 0 means miss updates helped; `d_rmst` < 0 means faster; distance is over all episodes "
         "(flown until first detection or the deadline).\n"]
    by = {(r["scenario"], r["policy"]): r for r in rows}
    abl = [d for d in diffs if d["baseline"] == "belief_noneg"]
    L.append(md_table(abl, [
        ("scenario", "scenario"),
        ("BeliefView reacquired", lambda r: f"{by[(r['scenario'], 'belief')]['found_by_deadline']:.2f}"),
        ("ablation reacquired", lambda r: f"{by[(r['scenario'], 'belief_noneg')]['found_by_deadline']:.2f}"),
        ("d_found [95% CI]", lambda r: f"{r['d_found']:+.3f} [{r['d_found_lo']:+.3f}, {r['d_found_hi']:+.3f}]"),
        ("d_rmst [95% CI]", lambda r: f"{r['d_rmst']:+.1f} [{r['d_rmst_lo']:+.1f}, {r['d_rmst_hi']:+.1f}]"),
        ("d_distance [95% CI]", lambda r: f"{r['d_distance']:+.1f} [{r['d_distance_lo']:+.1f}, {r['d_distance_hi']:+.1f}]"),
        ("both found", "both_found"), ("only BeliefView", "belief_only_found"),
        ("only ablation", "baseline_only_found"), ("neither", "neither_found")]))
    L.extend(after_primary or [])
    L.append("\n## Per-scenario summary\n")
    L.append("`mean travel` is over all episodes (distance flown until first detection or the deadline). "
             "`looks/step` is the measured fraction of steps that counted as a new independent look under the shared look gate.\n")
    for s in SCENARIOS:
        L.append(f"### {s.name}\n\n{s.description}\n")
        rs = [r for r in rows if r["scenario"] == s.name]
        rs.sort(key=lambda r: policies.index(r["policy"]))
        L.append(md_table(rs, [("policy", lambda r: POL_LABEL[r["policy"]]),
                               ("reacquired by T", lambda r: f"{r['found_by_deadline']:.2f} [{r['found_lo']:.2f}, {r['found_hi']:.2f}]"),
                               ("unresolved", "unresolved"), ("timeouts (n)", "n_timeouts"),
                               ("RMST (steps, cap T)", lambda r: f"{r['rmst']:.1f} [{r['rmst_lo']:.1f}, {r['rmst_hi']:.1f}]"),
                               ("mean travel", lambda r: f"{r['mean_distance']:.1f}"),
                               ("looks/step", lambda r: f"{r['looks_per_step']:.2f}")]))
        L.append("\nOutside decision at the deadline (unresolved runs; declares 'subject left the area' if P(outside) >= %.1f). "
                 "True exits are scored here. The 'truth inside' denominators are small.\n" % cfg.experiment.tau_left)
        L.append(md_table(rs, [("policy", lambda r: POL_LABEL[r["policy"]]), ("unresolved n", "n_unresolved"),
                               ("truth left (n)", "n_unres_truth_left"),
                               ("correct 'left'", lambda r: f"{r['correct_left']} of {r['n_unres_truth_left']}"),
                               ("truth inside (n)", "n_unres_truth_inside"),
                               ("false 'left'", lambda r: f"{r['false_left']} of {r['n_unres_truth_inside']}"),
                               ("mean P(outside)", "mean_p_out"), ("actual left frac.", "frac_truth_left")]))
        L.append(f"\nConditional in-area {pct}% region at the deadline (unresolved runs). The region holds {pct}% of the belief "
                 "*given the subject is still inside*; its unconditional mass is about that times (1 - P(outside)) and is listed "
                 "separately. Coverage is counted only over unresolved runs whose subject is still inside.\n")
        L.append(md_table(rs, _region_cols()))
        L.append("")
    L.append("## Paired differences, BeliefView minus each other policy (same episodes)\n")
    L.append("`d_found` > 0 means BeliefView reacquired more often by the deadline; `d_rmst` < 0 means BeliefView was faster "
             "(restricted mean, timeouts counted at T); `d_distance` > 0 means BeliefView flew farther (all episodes). "
             "The four count columns are the paired deadline outcomes.\n")
    L.append(md_table(diffs, [("scenario", "scenario"), ("other policy", lambda r: POL_LABEL[r["baseline"]]),
                              ("d_found [95% CI]", lambda r: f"{r['d_found']:+.3f} [{r['d_found_lo']:+.3f}, {r['d_found_hi']:+.3f}]"),
                              ("d_rmst [95% CI]", lambda r: f"{r['d_rmst']:+.1f} [{r['d_rmst_lo']:+.1f}, {r['d_rmst_hi']:+.1f}]"),
                              ("d_distance [95% CI]", lambda r: f"{r['d_distance']:+.1f} [{r['d_distance_lo']:+.1f}, {r['d_distance_hi']:+.1f}]"),
                              ("both found", "both_found"), ("only BeliefView found", "belief_only_found"),
                              ("only other found", "baseline_only_found"), ("neither", "neither_found")]))
    L.append("\n## Exit-rate sensitivity (BeliefView, scenario D, truth hazard 0.08)\n")
    L.append(f"Region columns refer to the conditional in-area {pct}% region; coverage is over unresolved runs whose subject is still inside.\n")
    L.append(md_table(swrows, [("assumed exit rate", "assumed_exit"), ("n", "n"),
                               ("reacquired by T", lambda r: f"{r['found_by_deadline']:.2f} [{r['found_lo']:.2f}, {r['found_hi']:.2f}]"),
                               ("unresolved", "n_unresolved"), ("truth left", "n_unres_truth_left"),
                               ("correct 'left'", "correct_left"), ("truth inside", "n_unres_truth_inside"), ("false 'left'", "false_left"),
                               ("mean P(outside)", "mean_p_out"), ("actual left frac.", "frac_truth_left"),
                               ("region mass, unconditional", "region_uncond_mass"),
                               ("inside region (of truth inside)", lambda r: f"{r['region_cov_k']} of {r['region_cov_n']}")],
                      fmt={"assumed_exit": lambda v: f"{v:g}"}))
    L.append("\n## Reacquired-by-deadline split by true subject behaviour (evaluation-only labels)\n")
    L.append("Rows with n < 15 are flagged `small n` and should not be interpreted.\n")
    for s in SCENARIOS:
        L.append(f"### {s.name}\n")
        tab = []
        for b in BEHAVIORS:
            rr = {r["policy"]: r for r in bsplit if r["scenario"] == s.name and r["behavior"] == b}
            if not rr:
                continue
            nn = next(iter(rr.values()))["n"]
            tab.append({"behavior": b + (" (small n)" if nn < 15 else ""), "n": nn,
                        **{p: rr[p]["found_by_deadline"] for p in policies if p in rr}})
        L.append(md_table(tab, [("behaviour", "behavior"), ("n", "n")] + [(POL_LABEL[p], p) for p in policies],
                          ))
        L.append("")
    L.append("## Animations\n")
    L.append("The heatmap is the unconditional per-cell belief on a fixed colour scale; P(outside) is a separate bar.\n")
    for kind, sc, idx, beh, what, path in anims:
        L.append(f"- `{Path(path).name}`: {kind}; {sc}, {ep_word} episode {idx}, true behaviour {beh}; {what}.")
    (res / "results.md").write_text("\n".join(L) + "\n")


def write_log(cfg, frozen, n, secs, rows, anims, res=RES):
    import matplotlib
    L = ["# Experiment log\n", f"- beliefview {__version__}; python {platform.python_version()}; numpy {np.__version__}; matplotlib {matplotlib.__version__}",
         f"- frozen config hash: `{frozen['config_hash']}` (verified before the test run)",
         f"- chosen hyperparameters (tuned on validation only): `{json.dumps(frozen['chosen'])}`",
         "- BeliefView and its no-miss-update ablation share one planner setting (`planner`, including `lam`); "
         "the ablation has no separately tuned parameter",
         "- paired across policies: episode (trajectory, start, last-seen), per-step detection uniforms and measurement "
         "noise; NOT paired: the observations themselves, which depend on each policy's viewpoint",
         f"- base seed {cfg.experiment.base_seed}; episode streams = SeedSequence([base, scenario_idx, split_id(dev=0,val=1,test=2), idx])",
         f"- test episodes per scenario: {n}; scenarios: {[s.name for s in SCENARIOS]}; deadline {cfg.experiment.deadline}",
         f"- exit-rate sweep assumed values: {list(cfg.experiment.exit_sweep)} (scenario D, BeliefView only)",
         f"- max |sum(belief)+outside - 1| over all test runs: {max(r['max_conservation_err'] for r in rows):.2e}",
         f"- wall time of this run: {secs:.0f}s",
         "- animations: " + "; ".join(f"{k}={Path(p).name} ({sc} ep {i})" for k, sc, i, b, w, p in anims),
         "- raw per-episode records: results/test_records.jsonl, results/exit_sweep_records.jsonl"]
    (res / "experiment_log.md").write_text("\n".join(L) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("tune", "test"):
        p = sub.add_parser(name, help="v1 REPRODUCTION (earlier record); writes to results/v1_repro/ by default")
        p.add_argument("--workers", type=int, default=None)
        p.add_argument("--n", type=int, default=None, help="override test episodes per scenario")
        p.add_argument("--out", default=None, help="output directory (default results/v1_repro); must be that directory or inside it")
    from . import v2, v2_report
    p = sub.add_parser("v2-tune", help="v2 validation tuning (split id 3) and freeze; refuses if already frozen")
    p.add_argument("--workers", type=int, default=None)
    p = sub.add_parser("v2-final", help="the ONE v2 final run (split id 4); refuses a second inferential run")
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--repro-check", action="store_true",
                   help="deliberate reproducibility check: rerun into results/v2/repro_check/ and compare with "
                        "the recorded run; changes no headline artifact and supports no new inference")
    p = sub.add_parser("v2-report", help="rebuild v2 tables, figures, animations and the demo from saved records")
    p = sub.add_parser("demo", help="rebuild demo/ from the v2 CSVs (no episodes are run)")
    a = ap.parse_args(argv)
    {"tune": cmd_tune, "test": cmd_test, "v2-tune": v2.cmd_tune, "v2-final": v2.cmd_final,
     "v2-report": v2_report.cmd_report, "demo": v2_report.cmd_demo}[a.cmd](a)


if __name__ == "__main__":
    main()
