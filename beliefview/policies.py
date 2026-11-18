"""Search policies. All share the same controller, sensor and deadline; only the
decision rule differs. Policies see ONLY: their own pose, Observation objects and the
initial noisy last-seen measurement. They never receive the episode / true subject.
Every policy runs a belief filter so a stated probability region exists for reporting;
only the two planner policies use it to act.

Look gate: the simulator applies ONE gate (`LookTracker`) to whatever pose a policy
ends up in, so every policy senses on every new look, including while travelling. A
policy keeps its own mirror of the gate, built from the ASSUMED sensor and advanced
only from the Observation stream, for use in planning rollouts.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from .belief import BeliefFilter, BeliefModel, GridGeometry
from .config import BaselineParams, MapConfig, MotionAssumption, ObserverDyn, PlannerParams, SensorParams
from .dynamics import Command, Navigator
from .geometry import dist_point_rect
from .planner import Candidate, choose, evaluate, generate_candidates
from .sensor import LookTracker, Observation, Pose


class Policy:
    name = "base"

    def __init__(self, geo: GridGeometry, nav: Navigator, motion: MotionAssumption,
                 sensor: SensorParams, skip_miss: bool = False):
        self.geo, self.nav = geo, nav
        self.model = BeliefModel(geo, motion, sensor)
        self.filter = BeliefFilter(self.model, skip_miss_updates=skip_miss)
        self.tracker = LookTracker(sensor.look_period)
        self.last_seen = None
        self.trace = None  # last decision info, for animations

    def begin(self, pose0: Pose, last_seen_z, age: int = 0) -> None:
        self.last_seen = tuple(last_seen_z)
        self.tracker = LookTracker(self.model.sensor.look_period)
        self.filter.start(self.last_seen, age)

    def observe(self, obs: Observation) -> None:
        self.tracker.sync(obs.pose, obs.look)
        self.filter.step(obs)

    def decide(self, t: int, pose: Pose) -> Command:
        raise NotImplementedError


class StayPolicy(Policy):
    name = "stay"

    def decide(self, t, pose):
        return Command((), None, scan=True)  # hold position, yaw-scan the camera


class LastSeenPolicy(Policy):
    name = "last_seen"

    def decide(self, t, pose):
        path = self.nav.path((pose.x, pose.y), self.last_seen)
        return Command(path or (), None, scan=True)  # go to last-seen point then yaw-scan


class OrbitPolicy(Policy):
    name = "orbit"

    def __init__(self, *a, bp: BaselineParams, **kw):
        super().__init__(*a, **kw)
        self.bp = bp
        self.wps = None
        self.i = 0

    def begin(self, pose0, last_seen_z, age=0):
        super().begin(pose0, last_seen_z, age)
        rects = self.nav.m.obstacles
        r = min(rects, key=lambda q: dist_point_rect(last_seen_z[0], last_seen_z[1], q))
        cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        rad = 0.5 * math.hypot(r[2] - r[0], r[3] - r[1]) + self.bp.orbit_margin
        wps, seen = [], set()
        for k in range(24):
            th = 2 * math.pi * k / 24
            c = self.nav.nearest_free_cell(cx + rad * math.cos(th), cy + rad * math.sin(th))
            if c not in seen:
                seen.add(c)
                wps.append(self.nav.center(*c))
        self.wps = wps
        self.i = min(range(len(wps)), key=lambda k: math.dist(wps[k], (pose0.x, pose0.y)))

    def decide(self, t, pose):
        for _ in range(len(self.wps)):
            if math.dist((pose.x, pose.y), self.wps[self.i]) < 1.5:
                self.i = (self.i + 1) % len(self.wps)
            else:
                break
        path = self.nav.path((pose.x, pose.y), self.wps[self.i])
        if path is None:
            self.i = (self.i + 1) % len(self.wps)
            return Command((), None, scan=True)
        return Command(path, None)


class BeliefPolicy(Policy):
    """Greedy belief-based viewpoint planner."""
    name = "belief"
    skip_miss = False

    def __init__(self, *a, pp: PlannerParams, **kw):
        kw["skip_miss"] = self.skip_miss
        super().__init__(*a, **kw)
        self.pp = pp
        self._cmd: Optional[Command] = None
        self._left = 0

    def begin(self, pose0, last_seen_z, age=0):
        super().begin(pose0, last_seen_z, age)
        self._cmd, self._left = None, 0

    def decide(self, t, pose):
        if self._left <= 0 or self._cmd is None:
            h = self.filter.heat()
            tot = h.sum()
            cen = None
            if tot > 1e-9:
                cen = (float((h * self.geo.gx).sum() / tot), float((h * self.geo.gy).sum() / tot))
            cands = generate_candidates(pose, self.nav, self.pp, cen)
            evaluate(cands, pose, self.filter.b, self.filter.out, self.model, self.tracker.copy(), self.nav, self.pp)
            best = choose(cands)
            self._cmd, self._left = best.cmd, self.pp.commit
            self.trace = {"t": t, "cands": cands, "chosen": best}
        self._left -= 1
        return self._cmd


class BeliefNoNegPolicy(BeliefPolicy):
    """Clean ablation: the SAME class, planner parameters, candidate set, horizon, commit
    length, travel penalty and controller as BeliefPolicy. The single difference is that
    its filter does not apply miss (negative) updates; detections are still used."""
    name = "belief_noneg"
    skip_miss = True
