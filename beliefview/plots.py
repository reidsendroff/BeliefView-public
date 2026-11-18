"""Static figures. Okabe-Ito colour-blind-safe palette."""
from __future__ import annotations

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle

from .analysis import POL_LABEL

COL = {"stay": "#999999", "last_seen": "#E69F00", "orbit": "#56B4E9", "belief": "#D55E00", "belief_noneg": "#009E73",
       "belief_lam0": "#CC79A7"}
LS = {"belief": "-", "belief_noneg": "--", "belief_lam0": ":"}
ORDER = ["stay", "last_seen", "orbit", "belief_noneg", "belief_lam0", "belief"]  # belief_lam0 exists in v2 only


def draw_map(ax, m, label=True):
    for i, (x0, y0, x1, y1) in enumerate(m.obstacles):
        ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, fc="#333333", ec="k", zorder=3,
                               label="opaque obstacle" if (i == 0 and label) else None))
    for i, (x0, y0, x1, y1) in enumerate(m.foliage):
        ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, fc="#7fbf7b", ec="#1b7837", alpha=0.45, zorder=2,
                               label="foliage (reduced detection)" if (i == 0 and label) else None))
    ax.set_xlim(0, m.size); ax.set_ylim(0, m.size); ax.set_aspect("equal")


def comparison_figure(rows, diffs, curves, T, scen_names, path, n_note="",
                      title="BeliefView - synthetic 2D simulation, held-out test episodes, same subject trajectories for every policy. "):
    fig, axes = plt.subplots(2, 4, figsize=(18, 8), gridspec_kw={"height_ratios": [1.2, 1]})
    for j, sc in enumerate(scen_names):
        ax = axes[0, j]
        for p in ORDER:
            if (sc, p) in curves:
                ax.plot(range(T + 1), curves[(sc, p)], color=COL[p], ls=LS.get(p, "-"), lw=2.2 if p == "belief" else 1.6,
                        label=POL_LABEL[p])
        ax.set_title(sc.replace("_", " "), fontsize=11)
        ax.set_xlabel("time step"); ax.set_ylim(0, 1); ax.grid(alpha=0.3)
        if j == 0:
            ax.set_ylabel("cumulative fraction reacquired")
        if j == 0:
            ax.legend(fontsize=8, loc="upper left")
        ax2 = axes[1, j]
        rs = [r for r in rows if r["scenario"] == sc]
        order = ORDER
        rs = sorted(rs, key=lambda r: order.index(r["policy"]))
        y = np.arange(len(rs))
        f = np.array([r["found_by_deadline"] for r in rs])
        lo = f - np.array([r["found_lo"] for r in rs]); hi = np.array([r["found_hi"] for r in rs]) - f
        ax2.barh(y, f, xerr=[lo, hi], color=[COL[r["policy"]] for r in rs], capsize=3)
        ax2.set_yticks(y); ax2.set_yticklabels([POL_LABEL[r["policy"]] for r in rs] if j == 0 else [], fontsize=8)
        ax2.set_xlim(0, 1); ax2.set_xlabel(f"reacquired by deadline (T={T}), 95% bootstrap CI"); ax2.grid(alpha=0.3, axis="x")
    fig.suptitle(title + n_note,
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def exit_sweep_figure(rows, path, base_rate):
    fig, ax = plt.subplots(1, 3, figsize=(15, 4.2))
    h = [str(r["assumed_exit"]) for r in rows]
    x = np.arange(len(rows))
    f = np.array([r["found_by_deadline"] for r in rows])
    ax[0].errorbar(x, f, yerr=[f - [r["found_lo"] for r in rows], [r["found_hi"] for r in rows] - f], fmt="o-", color=COL["belief"], capsize=3)
    ax[0].set_ylabel("reacquired by deadline"); ax[0].set_title("BeliefView vs assumed exit rate")
    ax[1].plot(x, [r["mean_p_out"] for r in rows], "o-", color="#0072B2", label="mean stated P(outside) at deadline")
    ax[1].plot(x, [r["frac_truth_left"] for r in rows], "s--", color="k", label="actual fraction that left (evaluation-only)")
    ax[1].set_title("Outside-probability calibration (unresolved runs)"); ax[1].legend(fontsize=8)
    cl = [r["correct_left"] / max(1, r["n_unres_truth_left"]) for r in rows]
    fl = [r["false_left"] / max(1, r["n_unres_truth_inside"]) for r in rows]
    ax[2].plot(x, cl, "o-", color="#009E73", label="correct 'left area' rate")
    ax[2].plot(x, fl, "s-", color="#CC79A7", label="false 'left area' rate")
    ax[2].set_title("Deadline 'subject left the area' decisions\n(false-'left' rate has a denominator of only a few runs)", fontsize=9); ax[2].legend(fontsize=8)
    for a in ax:
        a.set_xticks(x); a.set_xticklabels(h); a.set_xlabel("assumed exit rate (per step near boundary); truth = %.2f" % base_rate)
        a.set_ylim(0, 1); a.grid(alpha=0.3)
    fig.tight_layout(); fig.savefig(path, dpi=130); plt.close(fig)


def map_figure(m, path):
    fig, ax = plt.subplots(figsize=(5, 5))
    draw_map(ax, m)
    ax.legend(loc="upper right", fontsize=8); ax.set_title("Synthetic 2D map (fixed for all episodes)")
    fig.tight_layout(); fig.savefig(path, dpi=110); plt.close(fig)
