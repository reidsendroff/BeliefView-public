"""All configuration dataclasses. Pure data: no simulation or inference logic.

"True" (simulator) and "assumed" (filter/planner) parameters are separate
objects on purpose; only the assumed ones may be given to inference code.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
from dataclasses import dataclass, field
from typing import Tuple

Rect = Tuple[float, float, float, float]  # x0, y0, x1, y1


@dataclass(frozen=True)
class MapConfig:
    size: float = 40.0  # square map [0,size]^2, one grid cell = 1 unit
    # Physical (optical) obstacles: these block line of sight and hold no belief mass. The
    # drone's collision geometry is these rectangles inflated by ObserverDyn.radius
    # (Navigator.inflated); inflated rectangles are never used for line of sight.
    obstacles: Tuple[Rect, ...] = (
        (9.0, 11.0, 15.0, 17.0),    # "rock"
        (24.0, 5.0, 28.0, 14.0),    # "tree trunk cluster"
        (19.0, 27.0, 31.0, 30.0),   # "wall / dense cover"
        (5.0, 27.0, 10.0, 33.0),    # "boulder"
    )
    foliage: Tuple[Rect, ...] = ((29.0, 17.0, 36.0, 25.0),)  # one foliage zone

    @property
    def n(self) -> int:
        return int(round(self.size))


@dataclass(frozen=True)
class SensorParams:
    p0: float = 0.9               # peak per-look detection probability (close, clear)
    fov_half_deg: float = 30.0    # half field of view
    max_range: float = 12.0
    r0: float = 6.0               # gaussian range falloff scale: exp(-(r/r0)^2)
    foliage_factor: float = 0.4   # multiplier when subject is in the foliage zone
    meas_sigma: float = 0.6       # std of position noise on a positive detection
    look_period: int = 3          # unchanged pose yields a new independent look only every k steps


@dataclass(frozen=True)
class MotionAssumption:
    """The FILTER's belief about subject motion (may differ from truth)."""
    speed: float = 0.3
    p_stop: float = 0.03
    p_resume: float = 0.05
    p_turn: float = 0.12          # per-step prob. of a 45-degree turn (split +/-)
    p_reverse: float = 0.005      # per-step prob. of doubling back (180 deg)
    diffusion: float = 0.03       # prob mass per 4-neighbour spread each step
    edge_exit_rate: float = 0.03  # EXIT-RATE ASSUMPTION: per-step prob. a moving subject
    edge_band: float = 2.0        # within this distance of the boundary leaves the area
    init_stop_prior: float = 0.15
    init_sigma: float = 0.8       # spread of belief around the last noisy measurement
    # (the filter is told how many steps ago the subject was last seen, and predicts forward that long)


@dataclass(frozen=True)
class ObserverDyn:
    speed: float = 1.5
    max_turn_deg: float = 50.0
    radius: float = 0.8           # obstacle inflation for the drone body
    arrive_tol: float = 0.6
    scan_yaw_deg: float = 30.0    # yaw rate of scanning baselines


@dataclass(frozen=True)
class PlannerParams:
    horizon: int = 12             # every candidate is scored over the same H steps (travel + hold)
    lam: float = 0.001            # travel-time cost per step of travel (score = P(detect within H) - lam*steps)
    commit: int = 3               # steps executed before replanning
    distances: Tuple[float, ...] = (4.0, 8.0, 12.0)
    n_dirs: int = 8
    n_stay_yaws: int = 8


@dataclass(frozen=True)
class BaselineParams:
    orbit_margin: float = 3.0     # orbit radius = obstacle half-diagonal-ish margin
    scan_yaw_deg: float = 30.0


@dataclass(frozen=True)
class TruthMotion:
    """Simulator's subject motion (evaluation world). Never passed to inference."""
    speed: float = 0.3
    heading_noise: float = 0.2
    behavior_probs: Tuple[Tuple[str, float], ...] = (
        ("continue", 0.30), ("turn", 0.25), ("stop", 0.20), ("conceal", 0.15), ("exit", 0.10),
    )
    stop_dur: Tuple[int, int] = (10, 25)
    lost_age: Tuple[int, int] = (15, 40)  # steps between last sighting and the start of the search
    edge_exit_rate: float = 0.03
    edge_band: float = 2.0


@dataclass(frozen=True)
class ScenarioSpec:
    name: str
    description: str
    truth_motion: TruthMotion
    true_sensor: SensorParams
    assumed_motion: MotionAssumption = MotionAssumption()
    assumed_sensor: SensorParams = SensorParams()


@dataclass(frozen=True)
class ExperimentConfig:
    deadline: int = 80
    n_dev: int = 20
    n_val: int = 40
    n_test: int = 100
    base_seed: int = 20261114
    tau_left: float = 0.5         # declare "left the area" at deadline if P(outside) >= tau_left
    credible_mass: float = 0.9    # mass of the CONDITIONAL in-area region (given subject still inside)
    bootstrap: int = 2000
    exit_sweep: Tuple[float, ...] = (0.0, 0.01, 0.03, 0.08, 0.2)


@dataclass(frozen=True)
class FrozenConfig:
    """Everything that is fixed before final test runs; hashed."""
    map: MapConfig = MapConfig()
    observer: ObserverDyn = ObserverDyn()
    experiment: ExperimentConfig = ExperimentConfig()
    # ONE planner setting, shared by BeliefView and its no-miss-update ablation.
    planner: PlannerParams = PlannerParams()
    baselines: BaselineParams = BaselineParams()
    scenarios: Tuple[ScenarioSpec, ...] = ()


def to_jsonable(obj):
    if dataclasses.is_dataclass(obj):
        return {k: to_jsonable(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(x) for x in obj]
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    return obj


def config_hash(obj) -> str:
    s = json.dumps(to_jsonable(obj), sort_keys=True)
    return hashlib.sha256(s.encode()).hexdigest()[:16]
