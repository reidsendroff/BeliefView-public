"""Regression tests added in the fix pass: clean ablation, shared look gate / sensing
rights, conditional in-area region, boundary-only exit flow, optical vs collision
obstacles, and exact observer-side line of sight."""
import dataclasses
import inspect
import math

import numpy as np
import pytest

from beliefview import experiment
from beliefview.analysis import unresolved_stats
from beliefview.belief import BeliefFilter, BeliefModel, GridGeometry
from beliefview.config import ExperimentConfig, FrozenConfig, MapConfig, MotionAssumption, ObserverDyn, SensorParams
from beliefview.dynamics import Command, Navigator, step_pose
from beliefview.experiment import SCENARIOS, build_config, make_policy
from beliefview.geometry import los_clear_many, segment_blocked, wrap_angle
from beliefview.runner import run_episode
from beliefview.sensor import LookTracker, Observation, Pose, true_detection_prob_point
from beliefview.world import make_episode

SPEC = SCENARIOS[0]


def _episode(m, nav, idx, deadline=20, never_detect=True):
    exp = ExperimentConfig(deadline=deadline)
    ep = make_episode(SPEC, 0, "dev", idx, exp.base_seed, m, nav, exp.deadline)
    if never_detect:
        ep = dataclasses.replace(ep, u=np.ones(deadline + 1))
    return ep, exp


# ------------------------------------------------------------------ clean ablation
def test_ablation_shares_every_planner_setting(m, nav):
    cfg = build_config(); geo = GridGeometry(m)
    names = [f.name for f in dataclasses.fields(FrozenConfig)]
    assert "planner" in names and not any("noneg" in n for n in names)   # one planner setting only
    assert not any("noneg" in k for k in experiment.TUNABLE_DEFAULTS)      # nothing tuned separately
    a = make_policy("belief", cfg, SPEC, geo, nav)
    b = make_policy("belief_noneg", cfg, SPEC, geo, nav)
    assert a.pp is b.pp is cfg.planner            # candidates, horizon, commit, travel penalty
    assert a.nav is b.nav and a.geo is b.geo      # controller / navigator
    assert a.model.motion == b.model.motion and a.model.sensor == b.model.sensor
    assert type(b).decide is type(a).decide       # same decision code
    assert (a.filter.skip_miss, b.filter.skip_miss) == (False, True)   # the one difference


def test_ablation_differs_only_through_miss_updates(m, nav):
    """Same belief in -> same decision out; and the beliefs diverge only once a miss is observed."""
    cfg = build_config(); geo = GridGeometry(m)
    ep, exp = _episode(m, nav, 0)
    a = make_policy("belief", cfg, SPEC, geo, nav)
    b = make_policy("belief_noneg", cfg, SPEC, geo, nav)
    for p in (a, b):
        p.begin(ep.observer0, ep.last_seen_z, ep.last_seen_age)
    assert np.array_equal(a.filter.b, b.filter.b) and a.filter.out == b.filter.out
    ca, cb = a.decide(1, ep.observer0), b.decide(1, ep.observer0)
    assert ca == cb                                # identical first decision (no observation yet)
    assert [c.label for c in a.trace["cands"]] == [c.label for c in b.trace["cands"]]
    assert [c.score for c in a.trace["cands"]] == [c.score for c in b.trace["cands"]]
    pose = step_pose(ep.observer0, ca, nav)
    dup = Observation(1, pose, False, False)       # a non-look step: no evidence for either
    a.observe(dup); b.observe(dup)
    assert np.array_equal(a.filter.b, b.filter.b)
    miss = Observation(2, pose, True, False)       # a look with no detection
    a.observe(miss); b.observe(miss)
    assert not np.array_equal(a.filter.b, b.filter.b)
    assert a.filter.n_miss_updates == 1 and b.filter.n_miss_updates == 0
    # give the ablation BeliefView's belief: it must now plan exactly as BeliefView does
    b.filter.b, b.filter.out = a.filter.b.copy(), a.filter.out
    a._left = b._left = 0
    assert a.decide(3, pose) == b.decide(3, pose)


# ------------------------------------------------------------------ sensing rights / look gate
@pytest.mark.parametrize("name", experiment.POLICIES)
def test_one_look_gate_for_every_policy_and_sensing_while_moving(m, nav, name):
    cfg = build_config(); geo = GridGeometry(m)
    ep, exp = _episode(m, nav, 2, deadline=30)
    pol = make_policy(name, cfg, SPEC, geo, nav)
    tr = []
    run_episode(ep, pol, SPEC, m, nav, exp, trace=tr)
    gate = LookTracker(SPEC.true_sensor.look_period)
    prev = ep.observer0
    moved_steps = 0
    for f in tr:
        assert f["look"] == gate.update(f["pose"])           # the same gate, whatever the policy
        if math.hypot(f["pose"].x - prev.x, f["pose"].y - prev.y) > gate.pos_tol:
            moved_steps += 1
            assert f["look"]                                 # a step that moved is always a new look
        prev = f["pose"]
    if name != "stay":
        assert moved_steps >= 3
    # the policy's own mirror of the gate (built from observations only) agrees with the simulator's
    assert pol.tracker.last == gate.last and pol.tracker.since == gate.since


def test_detection_can_happen_while_travelling(m, nav):
    """A baseline en route to its goal detects a visible subject on the way (it need not arrive first)."""
    cfg = build_config(); geo = GridGeometry(m)
    ep, exp = _episode(m, nav, 0, never_detect=False)
    T = exp.deadline
    ep = dataclasses.replace(ep, observer0=Pose(3.5, 3.5, 0.0), last_seen_z=(15.5, 3.5), last_seen_age=0,
                             traj=np.tile([9.0, 3.5], (T + 1, 1)), exit_step=None, u=np.zeros(T + 1))
    pol = make_policy("last_seen", cfg, SPEC, geo, nav)
    tr = []
    rec = run_episode(ep, pol, SPEC, m, nav, exp, trace=tr)
    assert rec["found"] and rec["t_detect"] == 1
    p = tr[0]["pose"]
    assert p.x > 3.5 + 1.0                                         # it moved this step
    assert math.dist((p.x, p.y), ep.last_seen_z) > nav.dyn.arrive_tol  # and has not arrived


def test_policies_are_not_handed_the_simulator_gate(m, nav):
    cfg = build_config(); geo = GridGeometry(m)
    for name in experiment.POLICIES:
        pol = make_policy(name, cfg, SPEC, geo, nav)
        assert list(inspect.signature(pol.decide).parameters) == ["t", "pose"], name


def test_scan_obeys_turn_limit(m):
    nav = Navigator(m, ObserverDyn(scan_yaw_deg=120.0, max_turn_deg=50.0))
    p = Pose(5.0, 5.0, 0.0)
    q = step_pose(p, Command((), None, scan=True), nav)
    assert abs(float(wrap_angle(q.h - p.h))) <= math.radians(50.0) + 1e-9


# ------------------------------------------------------------------ conditional in-area region
def test_region_is_conditional_on_inside_and_unconditional_mass_is_separate(geo, still):
    f = BeliefFilter(BeliefModel(geo, still, SensorParams()))
    b = np.zeros((9, geo.n, geo.n))
    cells = [(20, 20), (20, 21), (21, 20), (3, 3), (30, 5)]
    for c, w in zip(cells, [0.10, 0.05, 0.03, 0.015, 0.005]):   # 0.2 inside, 0.8 outside
        b[1][c] = w
    f.b, f.out = b, 0.8
    mask = f.credible_region(0.9)
    unc, cond = f.region_masses(mask)
    assert set(zip(*np.nonzero(mask))) == set(cells[:3])       # 0.18 of 0.20 inside = 90% given inside
    assert cond == pytest.approx(0.9) and unc == pytest.approx(0.18)
    assert unc < 0.9 * 0.25                                    # far below 90% unconditionally
    smaller = mask.copy(); smaller[cells[2]] = False
    assert f.region_masses(smaller)[1] < 0.9                   # minimal
    f.b, f.out = np.zeros_like(b), 1.0                         # nothing left inside
    assert f.credible_region(0.9).sum() == 0


def test_region_coverage_counts_only_subjects_still_inside():
    def rec(left, inside_region, declared):
        return dict(truth_left=left, truth_in_region=inside_region, declared_left=declared, p_out=0.5,
                    region_area=10, region_cond_mass=0.9, region_uncond_mass=0.45)
    un = [rec(True, None, True), rec(True, None, False), rec(True, None, False),
          rec(False, True, False), rec(False, False, True)]
    s = unresolved_stats(un)
    assert (s["region_cov_k"], s["region_cov_n"]) == (1, 2)
    assert s["region_coverage_inside"] == pytest.approx(0.5)       # not 1/5
    assert (s["correct_left"], s["n_unres_truth_left"]) == (1, 3)  # true exits stay in the outside table
    assert (s["false_left"], s["n_unres_truth_inside"]) == (1, 2)
    assert math.isnan(unresolved_stats([rec(True, None, True)])["region_coverage_inside"])


def test_run_record_region_fields_and_unconditional_heat(m, nav):
    cfg = build_config(); geo = GridGeometry(m)
    seen = set()
    for idx in range(8):
        ep, exp = _episode(m, nav, idx, deadline=25)
        pol = make_policy("belief", cfg, SPEC, geo, nav)
        tr = []
        r = run_episode(ep, pol, SPEC, m, nav, exp, trace=tr)
        for f in tr:   # animation heat is unconditional: it sums to 1 - P(outside), never renormalised
            assert float(f["heat"].sum()) == pytest.approx(1.0 - f["out"], abs=1e-5)
        assert not r["found"]
        assert r["region_cond_mass"] >= cfg.experiment.credible_mass - 1e-9
        assert r["region_uncond_mass"] == pytest.approx(r["region_cond_mass"] * (1 - r["p_out"]))
        assert (r["truth_in_region"] is None) == r["truth_left"]
        seen.add(r["truth_left"])
    assert seen == {True, False}   # both branches exercised


# ------------------------------------------------------------------ exit flow, optics, exact LOS
def test_exit_flow_only_at_the_boundary(geo):
    mo = MotionAssumption()   # full dynamics, edge band 2.0, hazard 0.03
    model = BeliefModel(geo, mo, SensorParams())
    b = np.zeros((9, geo.n, geo.n)); b[:, 20, 20] = 1 / 9          # interior, all modes
    _, out = model.predict(b, 0.0)
    assert out == 0.0                                              # no interior leak to outside
    still = MotionAssumption(p_stop=0, p_turn=0, p_reverse=0, diffusion=0, p_resume=0, edge_exit_rate=0.03)
    model = BeliefModel(geo, still, SensorParams())
    b = np.zeros((9, geo.n, geo.n)); b[3, 20, 38] = 1.0            # moving north, 1.5 units from the east edge
    _, out = model.predict(b, 0.0)
    assert out == pytest.approx(0.03)                              # band hazard only
    b = np.zeros((9, geo.n, geo.n)); b[0, 20, 38] = 1.0            # stopped in the band
    _, out = model.predict(b, 0.0)
    assert out == 0.0


def test_line_of_sight_uses_physical_not_inflated_obstacles(m, geo, nav):
    rock = m.obstacles[0]                       # (9, 11, 15, 17); inflated by the drone radius 0.8
    iy, ix = 14, 8                              # cell centre (8.5, 14.5): 0.5 outside the rock, inside its inflation
    assert not geo.block[iy, ix] and not nav.free[iy, ix]
    pose = Pose(4.5, 14.5, 0.0)
    assert geo.pd_field(SensorParams(), pose)[iy, ix] > 0.5        # visible; belief mass may sit there
    assert true_detection_prob_point(SensorParams(), m, pose, (8.5, 14.5)) > 0.5
    # a sight line that clips only the inflated margin is optically clear but not flyable
    p, q = (4.5, 10.5), (20.0, 10.5)            # 0.5 below the rock's bottom edge
    assert not segment_blocked(p, q, m.obstacles) and segment_blocked(p, q, nav.inflated)
    assert not nav.segment_ok(p, q)


def test_filter_visibility_is_exact_and_matches_simulator_at_cell_centres(m, geo, nav):
    sp = SensorParams()
    rng = np.random.default_rng(5)
    n_checked = n_shadow_edge = 0
    while n_checked < 40:
        x, y = rng.uniform(1, 39, 2)
        if not nav.free[nav.cell_of(x, y)[1], nav.cell_of(x, y)[0]]:
            continue
        n_checked += 1
        exact = los_clear_many((x, y), geo.pts, m.obstacles) & ~geo.block
        assert np.array_equal(geo.visible(x, y), exact)            # no snapping of the observer position
        snapped = los_clear_many((round(x * 2) / 2, round(y * 2) / 2), geo.pts, m.obstacles) & ~geo.block
        n_shadow_edge += int((snapped != exact).any())
        pose = Pose(float(x), float(y), float(rng.uniform(-3, 3)))
        pd = geo.pd_field(sp, pose)
        for _ in range(25):
            iy, ix = rng.integers(0, geo.n, 2)
            c = (float(geo.gx[iy, ix]), float(geo.gy[iy, ix]))
            assert pd[iy, ix] == pytest.approx(true_detection_prob_point(sp, m, pose, c), abs=1e-12)
    assert n_shadow_edge > 0   # the old 0.5-unit snapping would have differed for some of these poses
