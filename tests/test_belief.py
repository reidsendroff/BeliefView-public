import numpy as np
import pytest

from beliefview.belief import BeliefFilter, BeliefModel
from beliefview.config import MotionAssumption, SensorParams
from beliefview.sensor import LookTracker, Observation, Pose


def uniform_belief(geo, mode=1):
    b = np.zeros((9, geo.n, geo.n))
    free = ~geo.block
    b[mode][free] = 1.0
    return b / b.sum(), 0.0


def test_miss_clear_view_loses_mass_and_matches_formula(geo, still):
    model = BeliefModel(geo, still, SensorParams())
    b, out = uniform_belief(geo)
    pose = Pose(22.0, 21.0, 0.0)
    pd = geo.pd_field(model.sensor, pose)
    iy, ix = 21, 26  # clear cell ahead, outside foliage and obstacles
    assert pd[iy, ix] > 0.5
    b2, o2 = model.miss_update(b, out, pose)
    z = (b * (1 - pd)[None]).sum()
    assert b2[1, iy, ix] == pytest.approx(b[1, iy, ix] * (1 - pd[iy, ix]) / z)
    assert b2[1, iy, ix] < b[1, iy, ix]


def test_miss_behind_opaque_cover_barely_changes(geo, still):
    model = BeliefModel(geo, still, SensorParams())
    b, out = uniform_belief(geo)
    pose = Pose(20.0, 9.5, 0.0)            # facing the obstacle (24,5)-(28,14)
    pd = geo.pd_field(model.sensor, pose)
    behind = (9, 30)                       # (iy, ix) behind the obstacle on the same ray
    assert pd[behind] == 0.0
    front = (9, 23)                        # visible cell in front of it
    assert pd[front] > 0.3
    b2, _ = model.miss_update(b, out, pose)
    z = (b * (1 - pd)[None]).sum()
    # hidden cell changes ONLY by the global renormalisation 1/Z (tiny), the visible cell drops a lot
    assert b2[1][behind] / b[1][behind] == pytest.approx(1.0 / z)
    assert b2[1][behind] / b[1][behind] > 1.0
    assert b2[1][front] / b[1][front] < 0.7 * (b2[1][behind] / b[1][behind])


def test_miss_under_foliage_loses_less_than_clear(geo, still):
    sp = SensorParams()
    model = BeliefModel(geo, still, sp)
    pose = Pose(25.0, 17.5, 0.0)
    pd = geo.pd_field(sp, pose)
    f, c = (19, 30), (15, 30)  # (iy, ix): foliage cell vs clear cell, same range and |bearing|
    assert geo.foliage[f] and not geo.foliage[c]
    assert pd[f] == pytest.approx(sp.foliage_factor * pd[c])
    b, out = uniform_belief(geo)
    b2, _ = model.miss_update(b, out, pose)
    assert b2[1][f] > b2[1][c]  # foliage cell retains more probability after a miss


def test_analytic_posterior_with_outside_mass(geo, still):
    """Hand-computable: 0.3 in a visible cell, 0.5 hidden, 0.2 already outside."""
    model = BeliefModel(geo, still, SensorParams())
    pose = Pose(20.0, 9.5, 0.0)
    pd = geo.pd_field(model.sensor, pose)
    vis, hid = (9, 23), (9, 30)
    b = np.zeros((9, geo.n, geo.n)); b[1][vis] = 0.3; b[1][hid] = 0.5
    b2, o2 = model.miss_update(b, 0.2, pose)
    Z = 0.3 * (1 - pd[vis]) + 0.5 * 1.0 + 0.2 * 1.0
    assert o2 == pytest.approx(0.2 / Z)
    assert b2[1][vis] == pytest.approx(0.3 * (1 - pd[vis]) / Z)
    assert b2[1][hid] == pytest.approx(0.5 / Z)
    assert b2.sum() + o2 == pytest.approx(1.0)


def test_boundary_crossing_moves_mass_to_outside_analytic(geo):
    mo = MotionAssumption(p_stop=0, p_turn=0, p_reverse=0, diffusion=0, edge_exit_rate=0, p_resume=0, speed=0.6)
    model = BeliefModel(geo, mo, SensorParams())
    b = np.zeros((9, geo.n, geo.n)); b[1][20, 39] = 1.0   # heading east in last column
    b2, out = model.predict(b, 0.0)
    assert out == pytest.approx(0.6)
    assert b2[1][20, 39] == pytest.approx(0.4)
    # miss from a position that cannot see that cell leaves outside likelihood 1
    pose = Pose(5.0, 38.0, 0.0)
    pd = geo.pd_field(model.sensor, pose)
    assert pd[20, 39] == 0.0
    b3, o3 = model.miss_update(b2, out, pose)
    assert o3 == pytest.approx(0.6)  # nothing visible -> Z=1


def test_conservation_over_long_random_run(geo):
    model = BeliefModel(geo, MotionAssumption(), SensorParams())
    filt = BeliefFilter(model)
    filt.start((2.0, 3.0))  # near a corner: outside mass will grow
    tr = LookTracker(3)
    rng = np.random.default_rng(3)
    pose = Pose(10.0, 5.0, 0.2)
    for t in range(1, 120):
        pose = Pose(float(np.clip(pose.x + rng.normal(0, 1), 1, 39)), float(np.clip(pose.y + rng.normal(0, 1), 1, 39)),
                    float(rng.uniform(-3, 3)))
        filt.step(Observation(t, pose, tr.update(pose), False))
        assert filt.total == pytest.approx(1.0, abs=1e-9)
        assert (filt.b >= -1e-15).all() and filt.out >= 0
    assert filt.out > 0.05
    assert filt.b[:, geo.block].sum() == pytest.approx(0.0, abs=1e-12)  # nothing sits inside opaque cover


def test_heatmap_is_not_renormalised_to_one(geo):
    model = BeliefModel(geo, MotionAssumption(edge_exit_rate=0.3), SensorParams())
    f = BeliefFilter(model); f.start((3.0, 3.0))
    for t in range(40):
        f.step(Observation(t + 1, Pose(30, 30, 0), False, False))
    assert f.out > 0.05
    assert f.heat().sum() == pytest.approx(1.0 - f.out)


def test_fixed_heatmap_scale_constant():
    from beliefview import animate
    assert animate.VMAX == 0.05  # one constant scale used for every frame


def test_repeated_looks_from_unchanged_pose_not_overcounted(geo):
    model = BeliefModel(geo, MotionAssumption(), SensorParams())
    f = BeliefFilter(model); f.start((20.0, 9.5))
    tr = LookTracker(3)
    pose = Pose(20.0, 9.5, 0.0)
    for t in range(1, 31):
        f.step(Observation(t, pose, tr.update(pose), False))
    assert f.n_miss_updates == 10                 # 30 staring steps -> only 10 independent looks
    f2 = BeliefFilter(model); f2.start((20.0, 9.5))
    for t in range(1, 31):
        f2.step(Observation(t, pose, True, False))  # naive: every step counts
    assert f2.n_miss_updates == 30
    # naive filter becomes more confident that the visible region is empty than the look-gated one
    pd = geo.pd_field(model.sensor, pose)
    assert (f2.heat() * pd).sum() < (f.heat() * pd).sum()


def test_duplicate_look_gives_no_update(geo):
    model = BeliefModel(geo, MotionAssumption(), SensorParams())
    f = BeliefFilter(model); f.start((20.0, 9.5))
    g = BeliefFilter(model); g.start((20.0, 9.5))
    pose = Pose(20, 9.5, 0)
    f.step(Observation(1, pose, False, False))
    b, o = model.predict(g.b, g.out)
    assert np.allclose(f.b, b) and f.out == pytest.approx(o)


def test_detection_update_concentrates_and_zeroes_outside(geo):
    model = BeliefModel(geo, MotionAssumption(), SensorParams())
    b, out = uniform_belief(geo)
    pose = Pose(22.0, 21.0, 0.0)
    b2, o2 = model.detect_update(b, out, pose, (26.0, 21.0))
    assert o2 == 0.0 and b2.sum() == pytest.approx(1.0)
    h = b2.sum(0)
    assert np.unravel_index(h.argmax(), h.shape) in {(21, 25), (20, 25), (21, 26), (20, 26)}
    # a hidden cell cannot have produced a detection
    assert h[9, 30] == 0.0 and h[:, :][geo.block].sum() == 0.0


def test_noneg_ablation_skips_only_miss_updates(geo):
    model = BeliefModel(geo, MotionAssumption(), SensorParams())
    a = BeliefFilter(model, skip_miss_updates=True); a.start((20.0, 9.5))
    c = BeliefFilter(model, skip_miss_updates=False); c.start((20.0, 9.5))
    pose = Pose(20, 9.5, 0)
    a.step(Observation(1, pose, True, False)); c.step(Observation(1, pose, True, False))
    b, o = model.predict(*model.initial((20.0, 9.5)))
    assert np.allclose(a.b, b)        # predict only
    assert not np.allclose(c.b, b)    # miss update changed it
    # positive detections are still used by the ablation
    a.step(Observation(2, pose, True, True, (24.0, 9.5)))
    assert a.out == 0.0 and a.total == pytest.approx(1.0)
