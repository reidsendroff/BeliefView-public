"""Metrics, paired bootstrap intervals and markdown/CSV tables from episode records."""
from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path
from typing import Dict, List

import numpy as np

POL_LABEL = {"stay": "Stay (scan)", "last_seen": "Last-seen (scan)", "orbit": "Orbit obstacle",
             "belief": "BeliefView (greedy)", "belief_noneg": "Greedy, no miss-update (ablation)",
             "belief_lam0": "BeliefView with lam = 0 (reference arm)"}
BEHAVIORS = ["continue", "turn", "stop", "doubleback", "conceal", "exit"]


def _arr(recs, T):
    recs = sorted(recs, key=lambda r: r["idx"])
    found = np.array([r["found"] for r in recs], dtype=bool)
    t = np.array([r["t_detect"] if r["found"] else T for r in recs], dtype=float)
    return recs, found, t


def boot_ci(x, B, rng, q=(2.5, 97.5)):
    n = len(x)
    ix = rng.integers(0, n, size=(B, n))
    m = x[ix].mean(1)
    return float(np.percentile(m, q[0])), float(np.percentile(m, q[1]))


def curve(found, t, T):
    return np.array([(found & (t <= k)).mean() for k in range(T + 1)])


def unresolved_stats(un):
    """Deadline reporting for unresolved runs.

    Outside decision: scored on ALL unresolved runs, split by whether the subject truly left.
    Region coverage: scored ONLY on unresolved runs whose subject is still inside (a region
    inside the map cannot contain a subject that has left); reported as k of n because n is small.
    The region is the conditional in-area region; its unconditional mass is reported separately."""
    tl = [r for r in un if r["truth_left"]]
    ti = [r for r in un if not r["truth_left"]]
    nan = float("nan")
    k = sum(bool(r["truth_in_region"]) for r in ti)
    return dict(n_unresolved=len(un), n_unres_truth_left=len(tl), n_unres_truth_inside=len(ti),
                correct_left=sum(r["declared_left"] for r in tl),
                false_left=sum(r["declared_left"] for r in ti),
                mean_p_out=float(np.mean([r["p_out"] for r in un])) if un else nan,
                frac_truth_left=len(tl) / len(un) if un else nan,
                region_area=float(np.mean([r["region_area"] for r in un])) if un else nan,
                region_cond_mass=float(np.nanmean([r["region_cond_mass"] for r in un])) if un else nan,
                region_uncond_mass=float(np.mean([r["region_uncond_mass"] for r in un])) if un else nan,
                region_cov_k=k, region_cov_n=len(ti),
                region_coverage_inside=k / len(ti) if ti else nan)


def group(records):
    g = defaultdict(lambda: defaultdict(list))
    for r in records:
        g[r["scenario"]][r["policy"]].append(r)
    return g


def summarize(records, T, B, seed=7):
    rng = np.random.default_rng(seed)
    rows, diffs, curves = [], [], {}
    g = group(records)
    for sc, byp in g.items():
        arrs = {p: _arr(rs, T) for p, rs in byp.items()}
        for p, (rs, found, t) in arrs.items():
            n = len(rs)
            un = [r for r in rs if not r["found"]]
            lo, hi = boot_ci(found.astype(float), B, rng)
            rlo, rhi = boot_ci(t, B, rng)
            row = dict(scenario=sc, policy=p, n=n, found_by_deadline=found.mean(), found_lo=lo, found_hi=hi,
                       unresolved=1 - found.mean(), n_timeouts=int((~found).sum()),
                       rmst=t.mean(), rmst_lo=rlo, rmst_hi=rhi,
                       # all episodes: distance flown until first detection or the deadline
                       mean_distance=float(np.mean([r["distance"] for r in rs])),
                       looks_per_step=sum(r["n_looks"] for r in rs) / sum(r["steps"] for r in rs),
                       n_subject_exited=int(sum(r["exit_step"] is not None for r in rs)),
                       **unresolved_stats(un),
                       max_conservation_err=max(r["conservation_err"] for r in rs))
            rows.append(row)
            curves[(sc, p)] = curve(found, t, T)
        if "belief" in arrs:
            _, fb, tb = arrs["belief"]
            n = len(fb)
            ix = rng.integers(0, n, size=(B, n))
            for p, (rs, f, t) in arrs.items():
                if p == "belief" or len(f) != n:
                    continue
                d_f = fb.astype(float) - f.astype(float)
                d_t = tb - t
                # distance over ALL paired episodes (flown until first detection or the deadline)
                d_d = (np.array([r["distance"] for r in arrs["belief"][0]])
                       - np.array([r["distance"] for r in rs]))
                mf, mt, md = d_f[ix].mean(1), d_t[ix].mean(1), d_d[ix].mean(1)
                diffs.append(dict(scenario=sc, baseline=p, n_pairs=n,
                                  d_found=d_f.mean(), d_found_lo=np.percentile(mf, 2.5), d_found_hi=np.percentile(mf, 97.5),
                                  d_rmst=d_t.mean(), d_rmst_lo=np.percentile(mt, 2.5), d_rmst_hi=np.percentile(mt, 97.5),
                                  d_distance=d_d.mean(), d_distance_lo=np.percentile(md, 2.5),
                                  d_distance_hi=np.percentile(md, 97.5),
                                  both_found=int((fb & f).sum()),
                                  belief_only_found=int((fb & ~f).sum()), baseline_only_found=int((~fb & f).sum()),
                                  neither_found=int((~fb & ~f).sum())))
    return rows, diffs, curves


def behavior_split(records, min_n=15):
    rows = []
    g = defaultdict(list)
    for r in records:
        g[(r["scenario"], r["policy"], r["behavior"])].append(r)
    for (sc, p, b), rs in sorted(g.items()):
        rows.append(dict(scenario=sc, policy=p, behavior=b, n=len(rs),
                         found_by_deadline=float(np.mean([r["found"] for r in rs])),
                         mean_distance=float(np.mean([r["distance"] for r in rs])),
                         small_n=len(rs) < min_n))
    return rows


def exit_sweep(records_by_h, T, B, seed=11):
    rng = np.random.default_rng(seed)
    rows = []
    for h, rs in sorted(records_by_h.items()):
        rs = sorted(rs, key=lambda r: r["idx"])
        found = np.array([r["found"] for r in rs], dtype=float)
        un = [r for r in rs if not r["found"]]
        lo, hi = boot_ci(found, B, rng)
        rows.append(dict(assumed_exit=h, n=len(rs), found_by_deadline=found.mean(), found_lo=lo, found_hi=hi,
                         **unresolved_stats(un)))
    return rows


def write_csv(rows, path):
    if not rows:
        return
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for r in rows:
            w.writerow({k: (f"{v:.4f}" if isinstance(v, (float, np.floating)) else v) for k, v in r.items()})


def md_table(rows, cols, fmt=None):
    fmt = fmt or {}
    out = ["| " + " | ".join(h for h, _ in cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for r in rows:
        cells = []
        for h, k in cols:
            v = r[k] if not callable(k) else k(r)
            if isinstance(v, (float, np.floating)):
                v = f"{v:.3f}" if k not in fmt else fmt[k](v)
            cells.append(str(v))
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)
