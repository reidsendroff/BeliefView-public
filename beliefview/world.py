"""Simulator world: pre-rolled, policy-independent episodes with evaluation-only truth.

`Episode` is the ONLY holder of the true subject trajectory / behavior. Inference
modules (belief, planner, policies) must never import this module (enforced by a test).
All randomness is split into separate streams so every policy sees the identical
subject trajectory, last-seen measurement, detection uniforms and measurement noise.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

from .config import MapConfig, ObserverDyn, ScenarioSpec, TruthMotion
from .dynamics import Navigator
from .geometry import inflate, point_in_rect, segment_blocked, wrap_angle
from .sensor import Pose

# v1 streams: dev (development/tests), val (v1 tuning), test (v1 final; used twice, see README).
# v2 streams are new split ids that no earlier run touched: v2_val (v2 tuning), v2_final (v2 final).
SPLITS = {"dev": 0, "val": 1, "test": 2, "v2_val": 3, "v2_final": 4}


@dataclass
class Episode:
    scenario: str
    split: str
    idx: int
    behavior: str                      # EVALUATION ONLY
    observer0: Pose
    last_seen_z: Tuple[float, float]   # noisy measurement handed to the observer at t=0
    last_seen_age: int                 # steps since that sighting (known to the observer)
    lost_xy: Tuple[float, float]       # true position when sight was lost. EVALUATION ONLY
    traj: np.ndarray                   # (T+1, 2) true subject positions; nan after exit. EVALUATION ONLY
    exit_step: Optional[int]           # EVALUATION ONLY
    u: np.ndarray                      # paired detection uniforms
    noise: np.ndarray                  # paired measurement noise (standard normal)


def episode_streams(base_seed: int, scen_idx: int, split: str, idx: int):
    ss = np.random.SeedSequence([base_seed, scen_idx, SPLITS[split], idx])
    return [np.random.default_rng(s) for s in ss.spawn(4)]  # layout, traj, detection, noise


def _blocked_for_subject(p, obstacles):
    return any(point_in_rect(p[0], p[1], r) for r in obstacles)


def _sample_behavior(rng, tm: TruthMotion) -> str:
    names = [n for n, _ in tm.behavior_probs]
    p = np.array([w for _, w in tm.behavior_probs], dtype=float)
    return str(rng.choice(names, p=p / p.sum()))


def _layout(rng, m: MapConfig, nav: Navigator, sensor_los):
    """Observer start + a subject start hidden from it behind an obstacle."""
    for _ in range(500):
        O = m.obstacles[int(rng.integers(len(m.obstacles)))]
        cx, cy = (O[0] + O[2]) / 2, (O[1] + O[3]) / 2
        ang = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(9.0, 15.0)
        ox, oy = cx + d * math.cos(ang), cy + d * math.sin(ang)
        if not nav.in_bounds(ox, oy) or not nav.free[nav.cell_of(ox, oy)[1], nav.cell_of(ox, oy)[0]]:
            continue
        half = 0.5 * math.hypot(O[2] - O[0], O[3] - O[1])
        for _ in range(30):
            a2 = ang + math.pi + rng.uniform(-0.9, 0.9)
            r2 = half + rng.uniform(0.8, 3.5)
            sx, sy = cx + r2 * math.cos(a2), cy + r2 * math.sin(a2)
            if not (2.0 < sx < m.size - 2.0 and 2.0 < sy < m.size - 2.0):
                continue
            if any(point_in_rect(sx, sy, inflate(r, 0.4)) for r in m.obstacles):
                continue
            if segment_blocked((ox, oy), (sx, sy), m.obstacles):
                h = math.atan2(cy - oy, cx - ox) + rng.uniform(-0.2, 0.2)
                return Pose(ox, oy, float(wrap_angle(h))), (sx, sy), O
    raise RuntimeError("could not sample a layout")


def _hide_point(m: MapConfig, start, obs_xy):
    pts = []
    for (x0, y0, x1, y1) in m.foliage:
        pts.append(((x0 + x1) / 2, (y0 + y1) / 2))
    for r in m.obstacles:
        cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        v = np.array([cx - obs_xy[0], cy - obs_xy[1]])
        v /= np.linalg.norm(v)
        half = 0.5 * math.hypot(r[2] - r[0], r[3] - r[1])
        p = (cx + v[0] * (half + 1.0), cy + v[1] * (half + 1.0))
        if 1.0 < p[0] < m.size - 1.0 and 1.0 < p[1] < m.size - 1.0 and not any(
                point_in_rect(p[0], p[1], inflate(q, 0.4)) for q in m.obstacles):
            pts.append(p)
    return min(pts, key=lambda p: math.dist(p, start))


def _simulate_subject(rng, m: MapConfig, tm: TruthMotion, behavior: str, start, obs_xy, T: int):
    size = m.size
    traj = np.full((T + 1, 2), np.nan)
    pos = np.array(start, dtype=float)
    traj[0] = pos
    obst = [inflate(r, 0.3) for r in m.obstacles]
    heading = rng.uniform(0, 2 * math.pi)
    hide = None
    if behavior == "exit":
        dists = [pos[0], size - pos[0], pos[1], size - pos[1]]
        k = int(np.argmin(dists))
        heading = [math.pi, 0.0, -math.pi / 2, math.pi / 2][k]
    if behavior == "conceal":
        hide = np.array(_hide_point(m, start, obs_xy))
    ev = {}
    if behavior == "turn":
        ev["turn1"] = int(rng.integers(3, 16))
        ev["turn1a"] = rng.choice([-1, 1]) * rng.uniform(math.radians(60), math.radians(120))
        if rng.random() < 0.5:
            ev["turn2"] = ev["turn1"] + int(rng.integers(8, 21))
            ev["turn2a"] = rng.choice([-1, 1]) * rng.uniform(math.radians(60), math.radians(120))
    if behavior == "doubleback":
        ev["rev"] = int(rng.integers(5, 16))
    stop_at = stop_until = None
    if behavior == "stop":
        stop_at = int(rng.integers(2, 11))
        stop_until = stop_at + int(rng.integers(tm.stop_dur[0], tm.stop_dur[1] + 1))
    exit_step = None
    stopped_forever = False
    for t in range(1, T + 1):
        moving = True
        if behavior == "stop" and stop_at <= t < stop_until:
            moving = False
        if stopped_forever:
            moving = False
        if behavior == "turn":
            if t == ev["turn1"]:
                heading += ev["turn1a"]
            if "turn2" in ev and t == ev["turn2"]:
                heading += ev["turn2a"]
        if behavior == "doubleback" and t == ev["rev"]:
            heading += math.pi
        if hide is not None and moving:
            dv = hide - pos
            if np.linalg.norm(dv) < 0.5:
                stopped_forever = True
                moving = False
            else:
                heading = math.atan2(dv[1], dv[0])
        if moving:
            heading += rng.normal(0, tm.heading_noise)
            moved = False
            for off in (0.0, 0.785, -0.785, 1.57, -1.57, 2.36, -2.36):
                h2 = heading + off
                q = pos + tm.speed * np.array([math.cos(h2), math.sin(h2)])
                inside = 0 <= q[0] <= size and 0 <= q[1] <= size
                if inside and _blocked_for_subject(q, obst):
                    continue
                heading, pos, moved = h2, q, True
                break
            if not moved:
                moving = False
            if not (0 <= pos[0] <= size and 0 <= pos[1] <= size):
                exit_step = t
                break
            band = min(pos[0], size - pos[0], pos[1], size - pos[1]) < tm.edge_band
            if moving and band and rng.random() < tm.edge_exit_rate:
                exit_step = t
                break
        traj[t] = pos
    return traj, exit_step


def make_episode(spec: ScenarioSpec, scen_idx: int, split: str, idx: int, base_seed: int,
                 m: MapConfig, nav: Navigator, deadline: int) -> Episode:
    r_layout, r_traj, r_det, r_noise = episode_streams(base_seed, scen_idx, split, idx)
    pose0, start, _ = _layout(r_layout, m, nav, None)
    behavior = _sample_behavior(r_traj, spec.truth_motion)
    lo, hi = spec.truth_motion.lost_age
    age = int(r_traj.integers(lo, hi + 1))
    full, fx = _simulate_subject(r_traj, m, spec.truth_motion, behavior, start,
                                 (pose0.x, pose0.y), deadline + age)
    traj = full[age:]                  # index 0 = moment the search starts
    exit_step = None if fx is None else max(0, fx - age)
    zn = r_noise.normal(0, 1, size=(deadline + 2, 2))
    last_seen = (start[0] + zn[0, 0] * spec.true_sensor.meas_sigma,
                 start[1] + zn[0, 1] * spec.true_sensor.meas_sigma)
    u = r_det.uniform(size=deadline + 1)
    return Episode(spec.name, split, idx, behavior, pose0, last_seen, age, (float(start[0]), float(start[1])), traj, exit_step, u, zn[1:])
