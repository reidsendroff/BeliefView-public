"""Geometry: opaque axis-aligned rectangles and line of sight.

Edge convention (tested): a sight line is blocked only if it passes through a
rectangle's open interior. Grazing an edge, touching a corner, or ending exactly on
the boundary is NOT blocked. A target strictly inside a rectangle IS blocked.
"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np

EPS = 1e-9


def wrap_angle(a):
    return (np.asarray(a) + np.pi) % (2 * np.pi) - np.pi


def inflate(rect, r):
    x0, y0, x1, y1 = rect
    return (x0 - r, y0 - r, x1 + r, y1 + r)


def point_in_rect(x, y, rect, strict=True):
    x0, y0, x1, y1 = rect
    if strict:
        return (x0 < x < x1) and (y0 < y < y1)
    return (x0 <= x <= x1) and (y0 <= y <= y1)


def segment_blocked(p, q, rects: Sequence) -> bool:
    """Scalar: does segment p->q pass through the open interior of any rect?"""
    for (x0, y0, x1, y1) in rects:
        t0, t1 = 0.0, 1.0
        ok = True
        for a, d, lo, hi in ((p[0], q[0] - p[0], x0, x1), (p[1], q[1] - p[1], y0, y1)):
            if abs(d) < EPS:
                if not (lo + EPS < a < hi - EPS):
                    ok = False
                    break
            else:
                ta, tb = (lo - a) / d, (hi - a) / d
                if ta > tb:
                    ta, tb = tb, ta
                t0, t1 = max(t0, ta), min(t1, tb)
        if ok and t0 < t1 - EPS:
            return True
    return False


def los_clear_many(p, targets: np.ndarray, rects: Sequence) -> np.ndarray:
    """Vectorised line of sight from point p to targets (...,2). True where clear."""
    px, py = p
    tx, ty = targets[..., 0], targets[..., 1]
    clear = np.ones(tx.shape, dtype=bool)
    for (x0, y0, x1, y1) in rects:
        t0 = np.zeros(tx.shape)
        t1 = np.ones(tx.shape)
        ok = np.ones(tx.shape, dtype=bool)
        for a, tgt, lo, hi in ((px, tx, x0, x1), (py, ty, y0, y1)):
            d = tgt - a
            par = np.abs(d) < EPS
            safe = np.where(par, 1.0, d)
            ta = (lo - a) / safe
            tb = (hi - a) / safe
            tmin, tmax = np.minimum(ta, tb), np.maximum(ta, tb)
            inside = (lo + EPS < a) & (a < hi - EPS)
            ok &= np.where(par, inside, True)
            t0 = np.where(par, t0, np.maximum(t0, tmin))
            t1 = np.where(par, t1, np.minimum(t1, tmax))
        hit = ok & (t0 < t1 - EPS)
        clear &= ~hit
    return clear


def dist_point_rect(x, y, rect) -> float:
    x0, y0, x1, y1 = rect
    dx = max(x0 - x, 0.0, x - x1)
    dy = max(y0 - y, 0.0, y - y1)
    return math.hypot(dx, dy)
