"""Observer motion: ONE collision-checked, speed- and turn-limited controller and one
grid navigator, used identically by every policy and by the planner's rollouts."""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

from .config import MapConfig, ObserverDyn
from .geometry import dist_point_rect, inflate, segment_blocked, wrap_angle
from .sensor import Pose

_NB = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
       (1, 1, math.sqrt(2)), (1, -1, math.sqrt(2)), (-1, 1, math.sqrt(2)), (-1, -1, math.sqrt(2))]


@dataclass(frozen=True)
class Command:
    """Waypoint path to follow (cell-centre polyline ending at the goal), then yaw to
    `final_heading`. If `scan` is set, yaw at the scan rate instead of holding."""
    path: Tuple[Tuple[float, float], ...] = ()
    final_heading: Optional[float] = None
    scan: bool = False


class Navigator:
    def __init__(self, m: MapConfig, dyn: ObserverDyn):
        self.m, self.dyn = m, dyn
        self.n = m.n
        self.inflated = tuple(inflate(r, dyn.radius) for r in m.obstacles)
        c = (np.arange(self.n) + 0.5) * (m.size / self.n)
        self.free = np.ones((self.n, self.n), dtype=bool)  # [iy, ix]
        for iy in range(self.n):
            for ix in range(self.n):
                x, y = c[ix], c[iy]
                if x < dyn.radius or y < dyn.radius or x > m.size - dyn.radius or y > m.size - dyn.radius:
                    self.free[iy, ix] = False
                    continue
                for r in self.inflated:
                    if r[0] < x < r[2] and r[1] < y < r[3]:
                        self.free[iy, ix] = False
                        break
        self._trees = {}

    # --- helpers
    def cell_of(self, x, y):
        s = self.m.size / self.n
        return (min(self.n - 1, max(0, int(x / s))), min(self.n - 1, max(0, int(y / s))))

    def center(self, ix, iy):
        s = self.m.size / self.n
        return ((ix + 0.5) * s, (iy + 0.5) * s)

    def in_bounds(self, x, y):
        r = self.dyn.radius
        return r <= x <= self.m.size - r and r <= y <= self.m.size - r

    def segment_ok(self, p, q) -> bool:
        return self.in_bounds(*q) and not segment_blocked(p, q, self.inflated)

    def nearest_free_cell(self, x, y):
        ix, iy = self.cell_of(x, y)
        if self.free[iy, ix]:
            return (ix, iy)
        best, bd = None, 1e9
        for jy in range(self.n):
            for jx in range(self.n):
                if self.free[jy, jx]:
                    cx, cy = self.center(jx, jy)
                    d = (cx - x) ** 2 + (cy - y) ** 2
                    if d < bd:
                        best, bd = (jx, jy), d
        return best

    # --- shortest-path tree from a start cell (Dijkstra, 8-neighbour, cached)
    def _tree(self, start):
        t = self._trees.get(start)
        if t is not None:
            return t
        dist = {start: 0.0}
        par = {start: None}
        pq = [(0.0, start)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for dx, dy, w in _NB:
                v = (u[0] + dx, u[1] + dy)
                if not (0 <= v[0] < self.n and 0 <= v[1] < self.n) or not self.free[v[1], v[0]]:
                    continue
                if dx and dy and not (self.free[u[1], v[0]] and self.free[v[1], u[0]]):
                    continue  # no diagonal corner cutting
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    par[v] = u
                    heapq.heappush(pq, (nd, v))
        if len(self._trees) > 400:
            self._trees.clear()
        self._trees[start] = (dist, par)
        return dist, par

    def path(self, start_xy, goal_xy) -> Optional[Tuple[Tuple[float, float], ...]]:
        """Collision-free cell polyline start->goal (goal snapped to nearest free cell)."""
        s = self.nearest_free_cell(*start_xy)
        g = self.nearest_free_cell(*goal_xy)
        dist, par = self._tree(s)
        if g not in dist:
            return None
        cells = []
        u = g
        while u is not None:
            cells.append(u)
            u = par[u]
        cells.reverse()
        return tuple(self.center(*c) for c in cells)

    def path_length(self, path) -> float:
        return sum(math.dist(path[i], path[i + 1]) for i in range(len(path) - 1))

    def lookahead(self, pos, path):
        i = min(range(len(path)), key=lambda k: (path[k][0] - pos[0]) ** 2 + (path[k][1] - pos[1]) ** 2)
        best = path[min(i + 1, len(path) - 1)]
        for j in range(i + 1, min(i + 6, len(path))):
            if self.segment_ok(pos, path[j]):
                best = path[j]
        return best


def step_pose(pose: Pose, cmd: Command, nav: Navigator) -> Pose:
    """One dt=1 step of the shared controller."""
    d = nav.dyn
    max_turn = math.radians(d.max_turn_deg)
    pos = (pose.x, pose.y)
    if not cmd.path:
        goal = pos
    else:
        goal = cmd.path[-1]
    dist_goal = math.dist(pos, goal)
    if dist_goal <= d.arrive_tol or not cmd.path:
        if cmd.scan:
            h = pose.h + min(math.radians(d.scan_yaw_deg), max_turn)  # scan obeys the turn limit
        elif cmd.final_heading is not None:
            err = float(wrap_angle(cmd.final_heading - pose.h))
            h = pose.h + max(-max_turn, min(max_turn, err))
        else:
            h = pose.h
        return Pose(pose.x, pose.y, float(wrap_angle(h)))
    tgt = nav.lookahead(pos, cmd.path)
    desired = math.atan2(tgt[1] - pos[1], tgt[0] - pos[0])
    err = float(wrap_angle(desired - pose.h))
    h = pose.h + max(-max_turn, min(max_turn, err))
    h = float(wrap_angle(h))
    rem = abs(float(wrap_angle(desired - h)))
    x, y = pose.x, pose.y
    if rem <= math.radians(60):
        step = min(d.speed, math.dist(pos, tgt))
        q = (x + step * math.cos(h), y + step * math.sin(h))
        if nav.segment_ok(pos, q):
            x, y = q
    return Pose(x, y, h)
