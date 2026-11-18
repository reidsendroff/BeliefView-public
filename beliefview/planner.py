"""Greedy one-shot viewpoint planner (greedy, NOT globally optimal).

For each reachable candidate (stay-and-yaw, or travel to a nearby cell and hold),
roll the shared controller forward H steps, predicting the belief step by step
and applying the expected miss update at each independent look. Score:

    score = P(reacquire within H steps | belief) - lam * (steps of travel)

Uses only the belief, assumed parameters and the observer's own pose.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from .belief import BeliefModel
from .config import PlannerParams
from .dynamics import Command, Navigator, step_pose
from .sensor import LookTracker, Pose


@dataclass
class Candidate:
    cmd: Command
    goal: tuple
    travel_steps: int
    gain: float = 0.0
    score: float = 0.0
    reachable: bool = True
    label: str = ""


def generate_candidates(pose: Pose, nav: Navigator, pp: PlannerParams, centroid=None) -> List[Candidate]:
    cands: List[Candidate] = []
    for k in range(pp.n_stay_yaws):  # k=0 is yaw-to-current-heading, i.e. "stay put"
        psi = pose.h + 2 * math.pi * k / pp.n_stay_yaws
        cands.append(Candidate(Command((), psi), (pose.x, pose.y), 0, label="stay" if k == 0 else f"yaw{k}"))
    seen = set()
    for k in range(pp.n_dirs):
        th = 2 * math.pi * k / pp.n_dirs
        for D in pp.distances:
            g = (pose.x + D * math.cos(th), pose.y + D * math.sin(th))
            if not (0 < g[0] < nav.m.size and 0 < g[1] < nav.m.size):
                continue
            cell = nav.nearest_free_cell(*g)
            gc = nav.center(*cell)
            if math.dist(gc, g) > 2.0 or cell in seen:
                continue
            seen.add(cell)
            path = nav.path((pose.x, pose.y), gc)
            if path is None:
                continue
            steps = math.ceil(nav.path_length(path) / nav.dyn.speed)
            # reachability uses the true controller rollout (checked in evaluate)
            cands.append(Candidate(Command(path, th), gc, steps, label=f"go{k}@{D:g}"))
            if centroid is not None:  # variant: hold facing the belief centroid
                bearing = math.atan2(centroid[1] - gc[1], centroid[0] - gc[0])
                if abs(math.remainder(bearing - th, 2 * math.pi)) > math.radians(20):
                    cands.append(Candidate(Command(path, bearing), gc, steps, label=f"go{k}@{D:g}c"))
    return cands


def evaluate(cands: List[Candidate], pose: Pose, b, out, model: BeliefModel, tracker: LookTracker,
             nav: Navigator, pp: PlannerParams) -> None:
    H = pp.horizon
    for c in cands:
        p = pose
        tr = tracker.copy()
        bb, oo = b, out
        arrived_at = None
        for t in range(1, H + 1):
            p = step_pose(p, c.cmd, nav)
            bb, oo = model.predict(bb, oo)
            if tr.update(p):
                pd = model.geo.pd_field(model.sensor, p)
                bb = bb * (1.0 - pd)[None]
            if arrived_at is None and c.cmd.path and math.dist((p.x, p.y), c.goal) <= nav.dyn.arrive_tol:
                arrived_at = t
        c.reachable = (not c.cmd.path) or arrived_at is not None
        c.travel_steps = 0 if not c.cmd.path else (arrived_at if arrived_at is not None else H + 1)
        c.gain = float(1.0 - (bb.sum() + oo))  # b,out are sub-normalised by the misses
        c.score = c.gain - pp.lam * c.travel_steps if c.reachable else -math.inf


def choose(cands: List[Candidate]) -> Candidate:
    best = cands[0]
    for c in cands[1:]:
        if c.score > best.score + 1e-12:
            best = c
    return best
