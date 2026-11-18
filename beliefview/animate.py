"""Matplotlib animations of a single episode (belief policy)."""
from __future__ import annotations

import math

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import animation
from matplotlib.patches import Wedge

from .plots import draw_map

VMAX = 0.05  # fixed colour scale for per-cell probability in EVERY frame


def render(frames, m, sensor, nav_path_fn, out_path, title, fps=6, extra_args=None):
    fig = plt.figure(figsize=(11, 6.6))
    ax = fig.add_axes([0.05, 0.1, 0.55, 0.78])
    axc = fig.add_axes([0.62, 0.1, 0.015, 0.78])
    axb = fig.add_axes([0.80, 0.52, 0.07, 0.36])
    axt = fig.add_axes([0.70, 0.08, 0.29, 0.34]); axt.axis("off")
    n = m.n
    im = ax.imshow(np.zeros((n, n)), origin="lower", extent=(0, m.size, 0, m.size), cmap="magma_r", vmin=0, vmax=VMAX, zorder=1, alpha=0.85)
    draw_map(ax, m)
    cb = fig.colorbar(im, cax=axc)
    cb.set_label(f"unconditional belief per cell (fixed 0-{VMAX}, not renormalised)", fontsize=8)
    wedge = Wedge((0, 0), sensor.max_range, 0, 1, fc="#56B4E9", alpha=0.22, ec="#0072B2", zorder=4)
    ax.add_patch(wedge)
    obs_pt, = ax.plot([], [], "o", ms=9, mfc="#0072B2", mec="w", zorder=7, label="observer drone")
    obs_dir, = ax.plot([], [], "-", color="#0072B2", lw=2, zorder=7)
    cand_sc = ax.scatter([], [], s=22, c=[], cmap="Greens", vmin=0, vmax=1, ec="k", lw=0.3, zorder=5, label="candidate viewpoints (shade = score)")
    chosen_ln, = ax.plot([], [], "-", color="#009E73", lw=2.5, zorder=6, label="chosen movement (greedy)")
    chosen_pt, = ax.plot([], [], "*", ms=12, mfc="#009E73", mec="k", zorder=8)
    truth_pt, = ax.plot([], [], "D", ms=8, mfc="none", mec="#D55E00", mew=2, zorder=8, label="evaluation-only ground truth")
    det_pt, = ax.plot([], [], "*", ms=26, mfc="#F0E442", mec="k", zorder=9, label="detection event")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.03), ncol=3, fontsize=7, frameon=False)
    bar = axb.bar([0], [0], color="#0072B2"); axb.set_ylim(0, 1); axb.set_xticks([])
    axb.set_title("P(outside\nsearch area)", fontsize=9)
    txt = axt.text(0, 1, "", va="top", fontsize=8, family="monospace")
    fig.suptitle(title, fontsize=9, y=0.985)

    def upd(i):
        f = frames[i]
        p = f["pose"]
        im.set_data(f["heat"])
        wedge.set_center((p.x, p.y)); wedge.set_theta1(math.degrees(p.h) - sensor.fov_half_deg)
        wedge.set_theta2(math.degrees(p.h) + sensor.fov_half_deg)
        wedge.set_alpha(0.35 if f["look"] else 0.12)
        obs_pt.set_data([p.x], [p.y]); obs_dir.set_data([p.x, p.x + 1.8 * math.cos(p.h)], [p.y, p.y + 1.8 * math.sin(p.h)])
        d = f["decision"]
        if d is not None:
            cs = [c for c in d["cands"] if np.isfinite(c.score)]
            if cs:
                sc = np.array([c.score for c in cs]); s0, s1 = sc.min(), sc.max()
                cand_sc.set_offsets(np.array([c.goal for c in cs]))
                cand_sc.set_array((sc - s0) / (s1 - s0 + 1e-9))
            ch = d["chosen"]
            pts = list(ch.cmd.path) if ch.cmd.path else [(p.x, p.y)]
            chosen_ln.set_data([q[0] for q in pts], [q[1] for q in pts])
            chosen_pt.set_data([ch.goal[0]], [ch.goal[1]])
        s = f["subject"]
        truth_pt.set_data([s[0]] if s else [], [s[1]] if s else [])
        det_pt.set_data([f["z"][0]] if f["detected"] else [], [f["z"][1]] if f["detected"] else [])
        bar[0].set_height(f["out"])
        txt.set_text(f"t = {f['t']:3d}\nP(outside) = {f['out']:.2f}\nlook this step: {'yes' if f['look'] else 'no (dup.)'}\n"
                     f"detected: {'YES' if f['detected'] else 'no'}\nsubject: {'inside' if s else 'LEFT area'}\n"
                     "(true position shown only\nfor evaluation)")
        return []

    ani = animation.FuncAnimation(fig, upd, frames=len(frames), interval=1000 // fps, blit=False)
    try:
        ani.save(out_path, writer=animation.FFMpegWriter(fps=fps, bitrate=1500, extra_args=extra_args))
    except Exception:
        out_path = out_path.replace(".mp4", ".gif")
        ani.save(out_path, writer=animation.PillowWriter(fps=fps))
    plt.close(fig)
    return out_path
