"""Discrete grid Bayes filter over (motion mode, cell) plus an absorbing OUTSIDE state.

State: b[m, y, x] with m=0 "stopped" and m=1..8 "moving at heading (m-1)*45 deg",
and `out`, the probability the subject has left the search area. Invariant:
b.sum() + out == 1 after every public operation.

Truth never enters this module: it consumes only `Observation` objects, the
initial noisy last-seen measurement, and ASSUMED parameters.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

from .config import MapConfig, MotionAssumption, SensorParams
from .geometry import los_clear_many, point_in_rect
from .sensor import Observation, Pose, detection_prob

N_MODES = 9
HEADINGS = np.arange(8) * np.pi / 4


class GridGeometry:
    """Static map-derived arrays and cached visibility, shared by filter and planner."""

    def __init__(self, m: MapConfig):
        self.m = m
        n = m.n
        self.n = n
        xs = (np.arange(n) + 0.5) * (m.size / n)
        self.gx, self.gy = np.meshgrid(xs, xs)  # [y, x]
        self.pts = np.stack([self.gx, self.gy], axis=-1)
        self.block = np.zeros((n, n), dtype=bool)
        for r in m.obstacles:
            self.block |= (r[0] < self.gx) & (self.gx < r[2]) & (r[1] < self.gy) & (self.gy < r[3])
        self.foliage = np.zeros((n, n), dtype=bool)
        for r in m.foliage:
            self.foliage |= (r[0] < self.gx) & (self.gx < r[2]) & (r[1] < self.gy) & (self.gy < r[3])
        self._vis = {}

    def edge_band(self, band: float) -> np.ndarray:
        d = np.minimum.reduce([self.gx, self.m.size - self.gx, self.gy, self.m.size - self.gy])
        return d < band

    def visible(self, x: float, y: float) -> np.ndarray:
        """LOS from the EXACT observer position to every cell centre, against the physical
        (optical) obstacles. Memoised on the exact position (no snapping), so the filter and
        the planner use the same observer-side geometry as the simulator. What remains
        approximate is the target side: a cell is represented by its centre."""
        key = (float(x), float(y))
        v = self._vis.get(key)
        if v is None:
            v = los_clear_many(key, self.pts, self.m.obstacles)
            v &= ~self.block
            if len(self._vis) > 20000:
                self._vis.clear()
            self._vis[key] = v
        return v

    def pd_field(self, sp: SensorParams, pose: Pose) -> np.ndarray:
        return detection_prob(sp, self.gx - pose.x, self.gy - pose.y, pose.h,
                              self.visible(pose.x, pose.y), self.foliage)


def _splat(dst, src, sx, sy, w, block, spill_total):
    """dst += w * src shifted by (sx, sy) cells. Mass shifted off-grid is returned as
    spill; mass that would land in an opaque-obstacle cell stays at its source cell."""
    H, W = src.shape[-2:]
    y0, y1 = max(0, -sy), min(H, H - sy)
    x0, x1 = max(0, -sx), min(W, W - sx)
    if y1 <= y0 or x1 <= x0:
        return w * spill_total
    part = src[..., y0:y1, x0:x1] * w
    blk = block[y0 + sy:y1 + sy, x0 + sx:x1 + sx]
    if blk.any():
        dst[..., y0 + sy:y1 + sy, x0 + sx:x1 + sx] += part * ~blk
        dst[..., y0:y1, x0:x1] += part * blk
    else:
        dst[..., y0 + sy:y1 + sy, x0 + sx:x1 + sx] += part
    return w * spill_total - part.sum()


class BeliefModel:
    """Assumed dynamics + assumed sensor on a fixed map. Stateless; operates on (b, out)."""

    def __init__(self, geo: GridGeometry, motion: MotionAssumption, sensor: SensorParams):
        self.geo, self.motion, self.sensor = geo, motion, sensor
        self.M = self._transition_matrix(motion)
        self.band = geo.edge_band(motion.edge_band)
        v = motion.speed * geo.n / geo.m.size
        self._moves = []
        for k, th in enumerate(HEADINGS):
            dx, dy = v * np.cos(th), v * np.sin(th)
            ix, iy = int(np.floor(dx + 1e-12)), int(np.floor(dy + 1e-12))
            fx, fy = dx - ix, dy - iy
            terms = []
            for a, wa in ((ix, 1 - fx), (ix + 1, fx)):
                for c, wc in ((iy, 1 - fy), (iy + 1, fy)):
                    w = wa * wc
                    if w > 1e-12:
                        terms.append((a, c, w))
            self._moves.append(terms)

    @staticmethod
    def _transition_matrix(mo: MotionAssumption) -> np.ndarray:
        M = np.zeros((N_MODES, N_MODES))  # M[i, j] = P(j -> i)
        M[0, 0] = 1 - mo.p_resume
        M[1:, 0] = mo.p_resume / 8
        for k in range(8):
            j = k + 1
            M[0, j] += mo.p_stop
            M[1 + (k + 1) % 8, j] += mo.p_turn / 2
            M[1 + (k - 1) % 8, j] += mo.p_turn / 2
            M[1 + (k + 4) % 8, j] += mo.p_reverse
            M[j, j] += 1 - mo.p_stop - mo.p_turn - mo.p_reverse
        assert np.allclose(M.sum(0), 1.0)
        return M

    # ----- construction -------------------------------------------------
    def initial(self, z) -> Tuple[np.ndarray, float]:
        g = self.geo
        s = self.motion.init_sigma
        k = np.exp(-((g.gx - z[0]) ** 2 + (g.gy - z[1]) ** 2) / (2 * s * s))
        k = np.where(g.block, 0.0, k)
        k /= k.sum()
        prior = np.full(N_MODES, (1 - self.motion.init_stop_prior) / 8)
        prior[0] = self.motion.init_stop_prior
        return prior[:, None, None] * k[None], 0.0

    # ----- dynamics -----------------------------------------------------
    def predict(self, b: np.ndarray, out: float) -> Tuple[np.ndarray, float]:
        g, mo = self.geo, self.motion
        b = np.tensordot(self.M, b, axes=(1, 0))
        new = np.zeros_like(b)
        new[0] = b[0]
        spill = 0.0
        for k in range(8):
            src = b[k + 1]
            tot = src.sum()
            for sx, sy, w in self._moves[k]:
                spill += _splat(new[k + 1], src, sx, sy, w, g.block, tot)
        # isotropic diffusion for moving modes only (4-neighbourhood)
        mv = new[1:]
        base = mv.copy()
        tot_mv = base.sum()
        q = mo.diffusion
        mv *= (1 - 4 * q)
        for sx, sy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            spill += _splat(mv, base, sx, sy, q, g.block, tot_mv)
        # exit-rate assumption: moving mass near the boundary leaves the area
        if mo.edge_exit_rate > 0:
            leave = new[1:] * (self.band * mo.edge_exit_rate)
            new[1:] -= leave
            spill += leave.sum()
        return new, out + spill

    # ----- observation updates -------------------------------------------
    def miss_update(self, b, out, pose: Pose):
        """Multiply by P(miss | state, view) = 1 - pd; outside likelihood is 1. Renormalise."""
        pd = self.geo.pd_field(self.sensor, pose)
        b = b * (1.0 - pd)[None]
        z = b.sum() + out
        return b / z, out / z

    def detect_update(self, b, out, pose: Pose, zmeas):
        """Positive detection: likelihood = pd(state, view) * N(z | cell, sigma). Outside -> 0."""
        pd = self.geo.pd_field(self.sensor, pose)
        s = self.sensor.meas_sigma
        lik = pd * np.exp(-((self.geo.gx - zmeas[0]) ** 2 + (self.geo.gy - zmeas[1]) ** 2) / (2 * s * s))
        b = b * lik[None]
        z = b.sum()
        if z <= 0:
            raise ValueError("detection has zero likelihood under the assumed model")
        return b / z, 0.0

    def expected_miss_mass(self, b, pose) -> float:
        return float((b * (1.0 - self.geo.pd_field(self.sensor, pose))[None]).sum())


class BeliefFilter:
    """Stateful wrapper around BeliefModel used by policies."""

    def __init__(self, model: BeliefModel, skip_miss_updates: bool = False):
        self.model = model
        self.skip_miss = skip_miss_updates
        self.b: Optional[np.ndarray] = None
        self.out = 0.0
        self.n_miss_updates = 0

    def start(self, last_seen_z, age: int = 0) -> None:
        """Initialise at the noisy last-seen point, then predict forward `age` unobserved steps."""
        self.b, self.out = self.model.initial(last_seen_z)
        for _ in range(age):
            self.b, self.out = self.model.predict(self.b, self.out)

    def step(self, obs: Observation) -> None:
        self.b, self.out = self.model.predict(self.b, self.out)
        if not obs.look:
            return  # duplicate look: suppressed, no evidence
        if obs.detected:
            self.b, self.out = self.model.detect_update(self.b, self.out, obs.pose, obs.z)
        elif not self.skip_miss:
            self.b, self.out = self.model.miss_update(self.b, self.out, obs.pose)
            self.n_miss_updates += 1

    @property
    def total(self) -> float:
        return float(self.b.sum() + self.out)

    def heat(self) -> np.ndarray:
        return self.b.sum(0)

    def credible_region(self, mass: float) -> np.ndarray:
        """CONDITIONAL in-area region: the smallest set of cells holding `mass` of the
        belief *given that the subject is still inside the area* (boolean mask).

        Its unconditional probability is about mass * (1 - P(outside)), which can be far
        below `mass`; use `region_masses` to report both. Empty if no in-area mass is left."""
        h = self.heat().ravel()
        mask = np.zeros(h.size, dtype=bool)
        tot = h.sum()
        if tot > 0:
            order = np.argsort(-h, kind="stable")
            c = np.cumsum(h[order])
            k = int(np.searchsorted(c, mass * tot)) + 1
            mask[order[:k]] = True
        return mask.reshape(self.geo_shape)

    def region_masses(self, mask: np.ndarray) -> Tuple[float, float]:
        """(unconditional mass, mass conditional on the subject being inside) of a cell mask."""
        h = self.heat()
        inside = float(h.sum())
        unc = float(h[mask].sum())
        return unc, (unc / inside if inside > 0 else float("nan"))

    @property
    def geo_shape(self):
        return self.model.geo.gx.shape
