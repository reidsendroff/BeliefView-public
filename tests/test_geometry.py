import numpy as np

from beliefview.geometry import los_clear_many, segment_blocked

R = [(10.0, 10.0, 20.0, 20.0)]


def clear(p, q):
    s = segment_blocked(p, q, R)
    v = bool(los_clear_many(p, np.array([q], dtype=float), R)[0])
    assert v == (not s), "scalar and vectorised LOS disagree"
    return v


def test_through_interior_blocked():
    assert not clear((5, 15), (25, 15))


def test_clear_far_away():
    assert clear((5, 5), (5, 25))


def test_grazing_edge_is_clear():
    assert clear((5, 10), (25, 10))   # runs along bottom edge
    assert clear((10, 5), (10, 25))   # runs along left edge


def test_touching_corner_is_clear():
    assert clear((5, 15), (15, 5))    # touches corner (10,10) only


def test_just_inside_corner_blocked():
    assert not clear((5, 15.2), (15.2, 5))  # clips the interior corner region... passes through (10, 10.2)


def test_ends_exactly_on_edge_is_clear():
    assert clear((5, 15), (10, 15))


def test_target_inside_is_blocked():
    assert not clear((5, 15), (15, 15))


def test_start_inside_is_blocked():
    assert not clear((15, 15), (30, 15))


def test_diagonal_through_corner_region_blocked():
    assert not clear((8, 8), (22, 22))


def test_vectorised_matches_scalar_random():
    rng = np.random.default_rng(0)
    pts = rng.uniform(0, 30, size=(500, 2))
    p = (3.3, 14.1)
    v = los_clear_many(p, pts, R)
    s = np.array([not segment_blocked(p, tuple(q), R) for q in pts])
    assert (v == s).all()
