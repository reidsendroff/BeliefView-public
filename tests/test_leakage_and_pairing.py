import ast
import dataclasses
from pathlib import Path

import numpy as np
import pytest

from beliefview import experiment
from beliefview.belief import GridGeometry
from beliefview.config import ExperimentConfig, PlannerParams, config_hash
from beliefview.experiment import SCENARIOS, build_config, make_policy
from beliefview.runner import run_episode
from beliefview.sensor import Observation
from beliefview.world import make_episode

PKG = Path(__file__).resolve().parent.parent / "beliefview"
INFERENCE = ["belief.py", "planner.py", "policies.py", "sensor.py", "dynamics.py", "geometry.py"]
FORBIDDEN_NAMES = {"traj", "exit_step", "behavior", "Episode", "truth", "u", "noise"}


def test_inference_modules_do_not_import_truth():
    for fn in INFERENCE:
        tree = ast.parse((PKG / fn).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert node.module not in ("world", "runner", "experiment", "analysis"), (fn, node.module)
                assert not any(a.name == "Episode" for a in node.names), fn
            if isinstance(node, ast.Import):
                assert not any("world" in a.name or "runner" in a.name for a in node.names), fn


def test_inference_modules_never_touch_truth_attributes():
    for fn in INFERENCE:
        tree = ast.parse((PKG / fn).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                assert node.attr not in {"traj", "exit_step", "behavior", "observer0"}, (fn, node.attr)


def test_observation_carries_only_observation_fields():
    assert [f.name for f in dataclasses.fields(Observation)] == ["t", "pose", "look", "detected", "z"]


def _spec():
    return SCENARIOS[0]


def _short_exp():
    return ExperimentConfig(deadline=20)


def test_policy_only_receives_observations(m, nav):
    cfg = build_config(); geo = GridGeometry(m); exp = _short_exp(); spec = _spec()
    ep = make_episode(spec, 0, "dev", 0, exp.base_seed, m, nav, exp.deadline)
    pol = make_policy("belief", cfg, spec, geo, nav)
    seen = []
    orig = pol.observe
    pol.observe = lambda o: (seen.append(o), orig(o))[1]
    run_episode(ep, pol, spec, m, nav, exp)
    assert seen and all(isinstance(o, Observation) for o in seen)


def test_identical_observations_give_identical_behaviour_regardless_of_truth(m, nav):
    """Metamorphic: swap the hidden truth, keep the observation stream (all misses) fixed."""
    cfg = build_config(); geo = GridGeometry(m); exp = _short_exp(); spec = _spec()
    e1 = make_episode(spec, 0, "dev", 0, exp.base_seed, m, nav, exp.deadline)
    e2 = make_episode(spec, 0, "dev", 5, exp.base_seed, m, nav, exp.deadline)
    never = np.ones(exp.deadline + 1)  # u=1 -> never detected, for either truth
    a = dataclasses.replace(e1, u=never)
    b = dataclasses.replace(e2, traj=e2.traj, behavior="exit", exit_step=3, u=never,
                            observer0=e1.observer0, last_seen_z=e1.last_seen_z, last_seen_age=e1.last_seen_age)
    assert not np.allclose(a.traj[:5], b.traj[:5], equal_nan=True)  # truths really differ
    for name in ("belief", "belief_noneg", "orbit", "last_seen"):
        ta, tb = [], []
        pa, pb = make_policy(name, cfg, spec, geo, nav), make_policy(name, cfg, spec, geo, nav)
        run_episode(a, pa, spec, m, nav, exp, trace=ta)
        run_episode(b, pb, spec, m, nav, exp, trace=tb)
        assert [f["pose"] for f in ta] == [f["pose"] for f in tb], name
        assert np.array_equal(pa.filter.b, pb.filter.b) and pa.filter.out == pb.filter.out, name


def test_trajectories_identical_across_all_policies(m, nav):
    cfg = build_config(); geo = GridGeometry(m); exp = _short_exp(); spec = _spec()
    eps = [make_episode(spec, 0, "dev", 3, exp.base_seed, m, nav, exp.deadline) for _ in range(5)]
    for e in eps[1:]:
        assert np.array_equal(e.traj, eps[0].traj, equal_nan=True) and np.array_equal(e.u, eps[0].u)
        assert e.last_seen_z == eps[0].last_seen_z and e.behavior == eps[0].behavior
    recs = []
    for pol in experiment.POLICIES:
        recs.append(run_episode(eps[0], make_policy(pol, cfg, spec, geo, nav), spec, m, nav, exp))
    assert len({(r["behavior"], r["exit_step"]) for r in recs}) == 1


def test_running_a_policy_does_not_mutate_the_episode(m, nav):
    cfg = build_config(); geo = GridGeometry(m); exp = _short_exp(); spec = _spec()
    ep = make_episode(spec, 0, "dev", 1, exp.base_seed, m, nav, exp.deadline)
    snap = (ep.traj.copy(), ep.u.copy(), ep.noise.copy(), ep.last_seen_z)
    run_episode(ep, make_policy("belief", cfg, spec, geo, nav), spec, m, nav, exp)
    assert np.array_equal(snap[0], ep.traj, equal_nan=True) and np.array_equal(snap[1], ep.u)


def test_splits_are_disjoint(m, nav):
    exp = _short_exp(); spec = _spec()
    tr = {s: make_episode(spec, 0, s, 0, exp.base_seed, m, nav, 20) for s in ("dev", "val", "test")}
    for a, b in (("dev", "val"), ("val", "test"), ("dev", "test")):
        assert tr[a].lost_xy != tr[b].lost_xy and tr[a].u[0] != tr[b].u[0]


def test_episodes_are_deterministic(m, nav):
    spec = _spec()
    a = make_episode(spec, 0, "test", 7, 123, m, nav, 30)
    b = make_episode(spec, 0, "test", 7, 123, m, nav, 30)
    assert np.array_equal(a.traj, b.traj, equal_nan=True) and a.last_seen_z == b.last_seen_z


def test_subject_never_inside_obstacle(m, nav):
    spec = _spec()
    for i in range(20):
        ep = make_episode(spec, 0, "dev", i, 1, m, nav, 80)
        for p in ep.traj:
            if np.isfinite(p[0]):
                assert not any(r[0] < p[0] < r[2] and r[1] < p[1] < r[3] for r in m.obstacles)
        assert ep.exit_step is None or not np.isfinite(ep.traj[ep.exit_step][0])


def test_subject_starts_hidden_from_observer(m, nav):
    from beliefview.geometry import segment_blocked
    spec = _spec()
    for i in range(20):
        ep = make_episode(spec, 0, "dev", i, 1, m, nav, 10)
        assert segment_blocked((ep.observer0.x, ep.observer0.y), ep.lost_xy, m.obstacles)


def test_config_hash_detects_changes():
    assert config_hash(build_config()) == config_hash(build_config())
    assert config_hash(build_config({"lam": 0.03})) != config_hash(build_config())


def test_frozen_config_matches_if_present():
    p = experiment.ROOT / "config" / "frozen.json"
    if p.exists():
        experiment.verify_frozen(build_config(experiment.load_frozen()["chosen"]), experiment.load_frozen())
