import math

import numpy as np
import pytest

from beliefview.config import MapConfig, ObserverDyn, PlannerParams
from beliefview.dynamics import Command, Navigator, step_pose
from beliefview.geometry import segment_blocked, wrap_angle
from beliefview.planner import generate_candidates
from beliefview.sensor import Pose


def test_stay_is_feasible_and_does_not_move(nav):
    p = Pose(10.0, 5.0, 0.3)
    q = step_pose(p, Command((), p.h), nav)
    assert (q.x, q.y) == (p.x, p.y) and q.h == pytest.approx(p.h)


def test_speed_turn_and_collision_limits(nav):
    d = nav.dyn
    rng = np.random.default_rng(1)
    for _ in range(25):
        while True:
            s = (rng.uniform(2, 38), rng.uniform(2, 38)); g = (rng.uniform(2, 38), rng.uniform(2, 38))
            if nav.free[nav.cell_of(*s)[1], nav.cell_of(*s)[0]] and nav.free[nav.cell_of(*g)[1], nav.cell_of(*g)[0]]:
                break
        path = nav.path(s, g)
        assert path is not None
        p = Pose(s[0], s[1], rng.uniform(-3, 3))
        for _ in range(120):
            q = step_pose(p, Command(path, 0.0), nav)
            assert math.hypot(q.x - p.x, q.y - p.y) <= d.speed + 1e-9
            assert abs(float(wrap_angle(q.h - p.h))) <= math.radians(d.max_turn_deg) + 1e-9
            assert not segment_blocked((p.x, p.y), (q.x, q.y), nav.inflated)
            assert nav.in_bounds(q.x, q.y)
            p = q
        assert math.dist((p.x, p.y), path[-1]) < 1.0  # actually reaches the goal around obstacles


def test_drone_cannot_pass_through_obstacle(nav):
    # goal is directly behind the rock; the "path" is a straight line through it
    p = Pose(5.0, 14.0, 0.0)
    bad = Command(((5.0, 14.0), (20.0, 14.0)), 0.0)
    for _ in range(60):
        p = step_pose(p, bad, nav)
        assert not any(r[0] < p.x < r[2] and r[1] < p.y < r[3] for r in nav.m.obstacles)


def test_unreachable_goal_has_no_path():
    m = MapConfig(obstacles=((4.0, 4.0, 5.0, 8.0), (8.0, 4.0, 9.0, 8.0), (4.0, 4.0, 9.0, 5.0), (4.0, 7.0, 9.0, 8.0)), foliage=())
    nav = Navigator(m, ObserverDyn(radius=0.3))
    assert nav.path((20.0, 20.0), (6.5, 6.5)) is None


def test_candidates_are_reachable_free_cells(nav):
    pose = Pose(18.0, 20.0, 0.0)
    cands = generate_candidates(pose, nav, PlannerParams())
    assert any(not c.cmd.path for c in cands)  # stay present
    for c in cands:
        if c.cmd.path:
            gx, gy = c.goal
            assert nav.free[nav.cell_of(gx, gy)[1], nav.cell_of(gx, gy)[0]]
            assert math.dist(c.cmd.path[-1], c.goal) < 1e-9
            # never a candidate inside an obstacle
            assert not any(r[0] < gx < r[2] and r[1] < gy < r[3] for r in nav.m.obstacles)


def test_planner_prediction_matches_execution(m, nav):
    from beliefview.belief import GridGeometry
    from beliefview.config import ExperimentConfig, ScenarioSpec, SensorParams, TruthMotion
    from beliefview.policies import BeliefPolicy
    from beliefview.runner import run_episode
    from beliefview.world import make_episode
    geo = GridGeometry(m)
    exp = ExperimentConfig(deadline=12)
    spec = ScenarioSpec("A", "", TruthMotion(), SensorParams())
    ep = make_episode(spec, 0, "dev", 2, exp.base_seed, m, nav, exp.deadline)
    pol = BeliefPolicy(geo, nav, spec.assumed_motion, spec.assumed_sensor, pp=PlannerParams())
    tr = []
    run_episode(ep, pol, spec, m, nav, exp, trace=tr)
    # replay: for each planning decision, rolling the chosen command from the same pose reproduces execution
    checked = 0
    for i, f in enumerate(tr):
        d = f["decision"]
        if d is None or d["t"] != f["t"]:
            continue
        pose = ep.observer0 if i == 0 else tr[i - 1]["pose"]
        cmd = d["chosen"].cmd
        for k in range(3):
            if i + k >= len(tr):
                break
            pose = step_pose(pose, cmd, nav)
            assert (pose.x, pose.y, pose.h) == (tr[i + k]["pose"].x, tr[i + k]["pose"].y, tr[i + k]["pose"].h)
            checked += 1
    assert checked >= 6
