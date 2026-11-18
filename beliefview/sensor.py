"""Sensor model shared by the simulator (TRUE params) and the filter (ASSUMED params).

This module contains only the detection-probability formula and a look gate. It
holds no subject state, so importing it into inference does not leak truth.

Looks: the sensor yields a new *independent* look only when the observer pose has
changed since the last counted look, or `look_period` steps have elapsed. Steps in
between are duplicates: no detection chance and no miss update. This prevents
staring from an unchanged viewpoint from producing falsely strong evidence.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .config import MapConfig, SensorParams
from .geometry import los_clear_many, point_in_rect, segment_blocked, wrap_angle


@dataclass(frozen=True)
class Pose:
    x: float
    y: float
    h: float  # heading, radians


@dataclass(frozen=True)
class Observation:
    """The ONLY thing the simulator hands to inference besides the initial last-seen."""
    t: int
    pose: Pose
    look: bool
    detected: bool
    z: Optional[tuple] = None  # noisy position measurement if detected


def detection_prob(sp: SensorParams, dx, dy, heading, visible, in_foliage):
    """P(detect | one independent look). Vectorised. Zero if not visible, out of FOV/range."""
    dx = np.asarray(dx, dtype=float)
    dy = np.asarray(dy, dtype=float)
    r = np.hypot(dx, dy)
    ang = wrap_angle(np.arctan2(dy, dx) - heading)
    in_fov = np.abs(ang) <= np.radians(sp.fov_half_deg)
    in_fov = in_fov | (r < 1e-9)
    p = sp.p0 * np.exp(-(r / sp.r0) ** 2)
    p = np.where(in_fov & (r <= sp.max_range) & visible, p, 0.0)
    # Foliage attenuates ONCE, and only by the subject's own location (subject inside a
    # foliage rectangle). A sight line that merely crosses foliage is not attenuated, and
    # there is no extra "concealing behaviour" factor anywhere: a subject hiding in foliage
    # is harder to see only through this multiplier; one hiding behind an opaque obstacle
    # only through line of sight.
    p = np.where(in_foliage, p * sp.foliage_factor, p)
    return p


def in_any(x, y, rects) -> bool:
    return any(point_in_rect(x, y, r) for r in rects)


def true_detection_prob_point(sp: SensorParams, m: MapConfig, pose: Pose, pos) -> float:
    """Exact-geometry detection probability for one point (used by the simulator).
    Line of sight uses the PHYSICAL (optical) obstacles `m.obstacles`, never the inflated
    collision obstacles the navigator uses for the drone body."""
    if segment_blocked((pose.x, pose.y), pos, m.obstacles):
        return 0.0
    if in_any(pos[0], pos[1], m.obstacles):
        return 0.0
    fol = in_any(pos[0], pos[1], m.foliage)
    return float(detection_prob(sp, pos[0] - pose.x, pos[1] - pose.y, pose.h, True, fol))


class LookTracker:
    """Decides, from the observer's own pose history, whether a step is a new look."""

    def __init__(self, look_period: int, pos_tol: float = 0.25, yaw_tol_deg: float = 10.0):
        self.k = look_period
        self.pos_tol = pos_tol
        self.yaw_tol = np.radians(yaw_tol_deg)
        self.last: Optional[Pose] = None
        self.since = 0

    def copy(self) -> "LookTracker":
        c = LookTracker(self.k, self.pos_tol, np.degrees(self.yaw_tol))
        c.last, c.since = self.last, self.since
        return c

    def update(self, pose: Pose) -> bool:
        if self.last is None:
            new = True
        else:
            moved = np.hypot(pose.x - self.last.x, pose.y - self.last.y) > self.pos_tol
            yawed = abs(float(wrap_angle(pose.h - self.last.h))) > self.yaw_tol
            new = moved or yawed or (self.since + 1 >= self.k)
        if new:
            self.last, self.since = pose, 0
        else:
            self.since += 1
        return bool(new)

    def sync(self, pose: Pose, look: bool) -> None:
        """Mirror the gate's state from a received Observation (pose + look flag), so a
        policy can roll the gate forward in its own planning without being handed the
        simulator's tracker object."""
        if look:
            self.last, self.since = pose, 0
        else:
            self.since += 1
