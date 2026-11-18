import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from beliefview.belief import BeliefModel, GridGeometry
from beliefview.config import MapConfig, MotionAssumption, ObserverDyn, SensorParams
from beliefview.dynamics import Navigator


@pytest.fixture(scope="session")
def m():
    return MapConfig()


@pytest.fixture(scope="session")
def geo(m):
    return GridGeometry(m)


@pytest.fixture(scope="session")
def nav(m):
    return Navigator(m, ObserverDyn())


@pytest.fixture(scope="session")
def still():
    """Motion assumption with no dynamics at all, for isolating observation updates."""
    return MotionAssumption(p_stop=0, p_turn=0, p_reverse=0, diffusion=0, edge_exit_rate=0, p_resume=0)
