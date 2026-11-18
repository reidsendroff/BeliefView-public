import numpy as np
from . import GRID_N
from .data import cell_centres

N2 = GRID_N * GRID_N
TAGS = ["all", "hide", "turn", "long", "reacq"]


def cum_before(prob):
    """For each sample and cell: probability mass of cells strictly before it in (prob desc, index asc) order."""
    order = np.argsort(-prob, axis=1, kind="stable")
    sp = np.take_along_axis(prob.astype(np.float64), order, 1)
    cb_sorted = np.cumsum(sp, 1) - sp
    cb = np.empty_like(cb_sorted)
    np.put_along_axis(cb, order, cb_sorted, 1)
    return cb


def truth_levels(prob, target, inside):
    cb = cum_before(prob)
    lv = np.full(len(prob), np.inf)
    lv[inside] = cb[np.where(inside)[0], target[inside]]
    return lv


def conformal(scores, target_cov=0.95):
    """Split-conformal threshold t such that P(score < t) >= target_cov on exchangeable data."""
    s = np.sort(scores)
    n = len(s)
    m = int(np.ceil((n + 1) * target_cov))
    if m > n or not np.isfinite(s[m - 1]):
        return None
    return float(s[m - 1])


def region_mass_level(val_scores, target_cov=0.95):
    t = conformal(val_scores, target_cov)
    if t is None:
        return 1.0
    q = float(np.ceil((t + 1e-6) * 1e6) / 1e6)  # region accumulates cells until mass >= q; truth included iff cum_before < q
    return min(q, 1.0)


def region_area_cells(prob, q):
    cb = cum_before(prob)
    return (cb < q).sum(1)


def peaks(prob_row, k=3, radius=2, min_mass=0.03):
    p = prob_row.reshape(GRID_N, GRID_N).copy()
    taken = np.zeros_like(p, bool)
    out = []
    for _ in range(k):
        masked = np.where(taken, -1, p)
        b = int(masked.argmax())
        if masked.flat[b] < 0:
            break
        bi, bj = divmod(b, GRID_N)
        sl = (slice(max(0, bi - radius), bi + radius + 1), slice(max(0, bj - radius), bj + radius + 1))
        sub_taken = taken[sl]
        mass = float(p[sl][~sub_taken].sum())
        if mass < min_mass and out:
            break
        out.append((b, mass))
        taken[sl] = True
    return out


def kalman_gauss(d, floor=1.0):
    """Discretised Gaussian around the tracker belief (uncalibrated; sigma = tracker radius/2.447)."""
    cc = cell_centres(d["center"])
    sig = np.maximum(d["kal"][:, 2] / 2.447, floor)
    d2 = ((cc - d["kal"][:, None, :2]) ** 2).sum(-1)
    p = np.exp(-d2 / (2 * sig[:, None] ** 2)) + 1e-12
    return (p / p.sum(1, keepdims=True)).astype(np.float32)


def summarize(x):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return {"n": 0}
    return {"n": int(len(x)), "mean": float(x.mean()), "median": float(np.median(x)), "p90": float(np.percentile(x, 90))}


def offline_report(d, prob, q_ml, k_kal):
    """Offline predictive metrics on exact held-out samples. `prob` [N,1024]. q_ml/k_kal were fit on the validation split only."""
    inside = d["inside"]
    tgt = np.where(inside, d["target"], 0)
    n = len(prob)
    cc = cell_centres(d["center"])
    truth = d["y"]
    kal_prob = kalman_gauss(d)
    pt = prob[np.arange(n), tgt].astype(np.float64)
    kt = kal_prob[np.arange(n), tgt].astype(np.float64)
    mean_xy = (prob[:, :, None] * cc).sum(1)
    map_xy = cc[np.arange(n), prob.argmax(1)]
    err_mean = np.hypot(*(mean_xy - truth).T)
    err_map = np.hypot(*(map_xy - truth).T)
    best3 = np.full(n, np.inf)
    n_peaks = np.zeros(n)
    for r in range(n):
        pk = peaks(prob[r])
        n_peaks[r] = sum(1 for _, m in pk if m >= 0.10)
        best3[r] = min(np.hypot(*(cc[r, c] - truth[r])) for c, _ in pk)
    kal_ok = d["kal"][:, 3] > 0
    err_kal = np.where(kal_ok, np.hypot(*(d["kal"][:, :2] - truth).T), np.inf)
    lv = truth_levels(prob, d["target"], inside)
    cov_raw = float((lv < 0.95).mean()) if n else float("nan")
    area_raw = region_area_cells(prob, 0.95)
    cov_ml = lv < q_ml
    area_ml = region_area_cells(prob, q_ml)
    rad = d["kal"][:, 2]
    kal_cov = np.where(kal_ok, np.hypot(*(d["kal"][:, :2] - truth).T) <= k_kal * rad, False)
    kal_area = np.pi * (k_kal * rad) ** 2
    kal_cov_raw = np.where(kal_ok, np.hypot(*(d["kal"][:, :2] - truth).T) <= rad, False)
    out = {}
    for tag in TAGS:
        m = np.ones(n, bool) if tag == "all" else d["tags"][tag]
        mi = m & inside
        if m.sum() == 0:
            out[tag] = {"samples": 0}
            continue
        out[tag] = {
            "samples": int(m.sum()), "episodes": int(len(set(d["ep"][m]))), "truth_outside_grid": int((m & ~inside).sum()),
            "nll_nats_ml": float(-np.log(np.maximum(pt[mi], 1e-9)).mean()),
            "nll_nats_tracker_gaussian_uncalibrated": float(-np.log(np.maximum(kt[mi], 1e-9)).mean()),
            "nll_nats_uniform": float(np.log(N2)),
            "err_m_ml_mean_estimate": summarize(err_mean[m]), "err_m_ml_map_cell": summarize(err_map[m]),
            "err_m_ml_best_of_top3_peaks": summarize(best3[m]), "err_m_kalman_point": summarize(err_kal[m]),
            "region95_raw_ml": {"coverage": float((lv[m] < 0.95).mean()), "mean_area_m2": float(area_raw[m].mean() * 16)},
            "region95_calibrated_ml": {"coverage": float(cov_ml[m].mean()), "mean_area_m2": float(area_ml[m].mean() * 16), "median_area_m2": float(np.median(area_ml[m]) * 16)},
            "region95_raw_kalman_ellipse": {"coverage": float(kal_cov_raw[m].mean())},
            "region95_calibrated_kalman": {"coverage": float(kal_cov[m].mean()), "mean_area_m2": float(np.mean(kal_area[m])), "median_area_m2": float(np.median(kal_area[m]))},
            "mean_peaks_ge10pct": float(n_peaks[m].mean()), "frac_two_or_more_peaks_ge10pct": float((n_peaks[m] >= 2).mean()),
        }
    out["_calibration"] = {"ml_region_mass_level": q_ml, "kalman_radius_scale": k_kal, "raw_ml_95_mass_coverage_all": cov_raw}
    return out


def fit_calibration(d, prob):
    lv = truth_levels(prob, d["target"], d["inside"])
    q = region_mass_level(lv)
    kal_ok = d["kal"][:, 3] > 0
    dist = np.where(kal_ok, np.hypot(*(d["kal"][:, :2] - d["y"]).T) / np.maximum(d["kal"][:, 2], 1e-6), np.inf)
    k = conformal(dist)
    return q, (float(np.ceil(k * 1e4) / 1e4) if k is not None else float("inf"))
