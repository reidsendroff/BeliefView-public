"""Assemble ml/RESULTS.md strictly from the measured JSON files. Claims are generated from the numbers (never hand-written)."""
import json, os


def _load(p):
    return json.load(open(p)) if os.path.exists(p) else None


def _f(x, d=2):
    return "n/a" if x is None else f"{x:.{d}f}"


def _verdict(stat, what, unit="s"):
    lo, hi = stat["ci95"]
    d = stat["meanDiffMlMinusKalman"]
    if stat["n"] == 0:
        return f"{what}: no paired episodes."
    if lo > 0:
        return f"{what}: learned guidance was **worse** (mean {d:+.2f} {unit}, 95% bootstrap CI [{lo:+.2f}, {hi:+.2f}])."
    if hi < 0:
        return f"{what}: learned guidance was **better** (mean {d:+.2f} {unit}, 95% bootstrap CI [{lo:+.2f}, {hi:+.2f}]) on these synthetic scenarios."
    return f"{what}: **no detectable difference** (mean {d:+.2f} {unit}, 95% bootstrap CI [{lo:+.2f}, {hi:+.2f}] includes 0)."


def _offline_tables(L, t, title_level="###"):
    cal = t["_calibration"]
    L += [f"Region calibration was fit on the **validation** split only (development run): learned region = highest-probability cells until mass >= {cal['ml_region_mass_level']}, chosen to TARGET 95% coverage; "
          f"Kalman ellipse radius scaled by x{cal['kalman_radius_scale']}. Coverage is **measured**, not guaranteed: compare the numbers below with the 95% target. "
          f"(Uncalibrated, the tracker's own 95% ellipse covered {t['all']['region95_raw_kalman_ellipse']['coverage']*100:.0f}% of truths while lost.) Truths outside the grid count as misses for the learned region.", "",
          "| subset | samples | episodes | NLL learned (nats) | NLL tracker-Gaussian | NLL uniform | median err learned mean-estimate (m) | median err learned MAP (m) | median err learned best-of-top-3 peaks (m) | median err Kalman (m) |", "|---|---|---|---|---|---|---|---|---|---|"]
    for tag in ("all", "hide", "turn", "long", "reacq"):
        r = t[tag]
        if not r.get("samples"):
            L.append(f"| {tag} | 0 | | | | | | | | |"); continue
        L.append(f"| {tag} | {r['samples']} | {r['episodes']} | {_f(r['nll_nats_ml'])} | {_f(r['nll_nats_tracker_gaussian_uncalibrated'])} | {_f(r['nll_nats_uniform'])} | {_f(r['err_m_ml_mean_estimate']['median'],1)} | {_f(r['err_m_ml_map_cell']['median'],1)} | {_f(r['err_m_ml_best_of_top3_peaks']['median'],1)} | {_f(r['err_m_kalman_point']['median'],1)} |")
    L += ["", "| subset | learned region MEASURED coverage (target 95%) | learned median area (m²) | Kalman ellipse measured coverage | Kalman median area (m²) | mean #peaks >=10% | share with >=2 peaks |", "|---|---|---|---|---|---|---|"]
    for tag in ("all", "hide", "turn", "long", "reacq"):
        r = t[tag]
        if not r.get("samples"):
            continue
        L.append(f"| {tag} | {r['region95_calibrated_ml']['coverage']*100:.1f}% | {r['region95_calibrated_ml']['median_area_m2']:.0f} | {r['region95_calibrated_kalman']['coverage']*100:.1f}% | {r['region95_calibrated_kalman']['median_area_m2']:.0f} | {r['mean_peaks_ge10pct']:.2f} | {r['frac_two_or_more_peaks_ge10pct']*100:.0f}% |")
    L += ["", "Subsets overlap. `hide` = subject crouched behind a tree at the tick; `turn` = a jink/feint since the last fix; `long` = >= 8 s since last fix; `reacq` = the loss ended with a re-acquisition. "
          "Compare measured coverage and region area together; the learned grid region and Kalman ellipse use different constructions. NLL excludes samples whose truth falls outside the 128 m grid, while coverage counts them as misses.", ""]


def _closed_section(L, cl, heading):
    c = cl["config"]
    L += [heading, "",
          f"{c['episodes']} `{c['split']}` scenarios ({c.get('evaluationRole', '')}), model `{c['model']}` sha256 `{c['modelSha256'][:16]}…`, runtime {c['runtime']}. {cl['note']}",
          "Primary baseline = Kalman guidance with the same coarse start as the learned run. The exact-start Kalman result is an evaluation-only legacy reference; neither browser guidance mode receives the subject's exact start position.",
          f"Median RMS divergence between the two runs' true subject paths: {cl['subjectDivergenceRmsM']['median']:.1f} m (p90 {cl['subjectDivergenceRmsM']['p90']:.1f} m).", "",
          "Primary comparison: learned vs Kalman **with the same coarse start**.", "",
          "| group | episodes | paired w/ loss | first-loss search time Kalman (s) | learned (s) | unobserved total Kalman (s) | learned (s) | ML better / worse / tie (unobserved) |", "|---|---|---|---|---|---|---|---|"]
    groups = [("all", cl["overall"], cl["overall"]["episodes"])] + [(g, cl["byScenarioGroup"][g], cl["groupCounts"][g]) for g in ("hide", "turn", "long", "reacq")]
    for name, st, n in groups:
        f, u = st["firstLossSearchTimeS"], st["unobservedTotalS"]
        L.append(f"| {name} | {n} | {st['bothRunsHaveALoss']} | {_f(f['meanKalman'])} | {_f(f['meanMl'])} | {_f(u['meanKalman'])} | {_f(u['meanMl'])} | {u['mlBetter']} / {u['mlWorse']} / {u['ties']} |")
    o = cl["overall"]
    L += ["", "Paired differences (learned - Kalman, negative = learned better), seeded bootstrap over episodes:", "",
          "- " + _verdict(o["firstLossSearchTimeS"], "Time from first loss to re-acquisition (censored at episode end)"),
          "- " + _verdict(o["unobservedTotalS"], "Total unobserved time per episode"), ""]
    for g in ("hide", "turn", "long", "reacq"):
        st = cl["byScenarioGroup"][g]
        if st["episodes"]:
            L.append(f"- [{g}, n={st['episodes']}] " + _verdict(st["unobservedTotalS"], "total unobserved time"))
    if "vsKalmanExactStart" in cl:
        x = cl["vsKalmanExactStart"]
        L += ["", "Evaluation-only legacy reference (exact-start Kalman, which starts at the subject's exact position; neither browser guidance mode receives that information):", "",
              "- " + _verdict(x["firstLossSearchTimeS"], "vs exact-start Kalman, time from first loss to re-acquisition"),
              "- " + _verdict(x["unobservedTotalS"], "vs exact-start Kalman, total unobserved time")]
    w = cl["mlWorseEpisodes"]
    pl = cl["physicalLimits"]
    L += ["", f"Physical limits observed over all episodes: Kalman min AGL {pl['kalman']['minAglM']:.2f} m / max horizontal speed {pl['kalman']['maxHSpeedMps']:.2f} m/s; learned min AGL {pl['ml']['minAglM']:.2f} m / max horizontal speed {pl['ml']['maxHSpeedMps']:.2f} m/s.",
          f"Learned guidance chose {cl['learnedGuidance']['viewpointChoicesByLearned']} search viewpoints and fell back to the Kalman viewpoint {cl['learnedGuidance']['fallbacksToKalmanViewpoint']} times over {cl['learnedGuidance']['predictionTicks']} prediction ticks.", "",
          "**ML-worse cases (retained, not hidden):**", "", f"Criterion: {w['criterion']}. **{w['count']} of {w['of']} episodes.**", ""]
    if w["cases"]:
        L += ["| episode | world / subject seed | groups | unobserved Kalman (s) | learned (s) | Δ (s) | subject-path divergence (m) |", "|---|---|---|---|---|---|---|"]
        for e in w["cases"][:15]:
            L.append(f"| {e['id']} | {e['worldSeed']} / {e['subjectSeed']} | {', '.join(e['groups']) or '-'} | {e['unobservedKalmanS']:.1f} | {e['unobservedMlS']:.1f} | {e['unobservedDiffS']:+.1f} | {e['divergenceRmsM']:.1f} |")
        if len(w["cases"]) > 15:
            L.append(f"\n(first 15 of {len(w['cases'])}; all in the matching `ml/results/*closed_loop.json`)")
    n = cl["nodeOnnxLatencyMs"]
    L += ["", f"Inference latency (Node, not a browser): {n['calls']} calls, p50 {n['p50']:.2f} ms, p95 {n['p95']:.2f} ms.", ""]


def write(demo3d_dir):
    res = os.path.join(demo3d_dir, "ml", "results")
    off, cl, br = _load(f"{res}/offline_metrics.json"), _load(f"{res}/closed_loop.json"), _load(f"{res}/browser_smoke.json")
    aoff, acl = _load(f"{res}/final_audit_offline.json"), _load(f"{res}/final_audit_closed_loop.json")
    L = ["# Measured results (synthetic simulator only)", "",
         "> Generated by `belief_ml/report.py` from `ml/results/*.json`. Synthetic, illustrative simulator: nothing here says anything about real people, drones or forests.", ""]
    if off:
        L += [f"Model sha256 `{off['modelSha256']}` · source sha256 `{off['sourceSha256'][:16]}…` · feature schema sha256 `{off['featureSchemaSha256'][:16]}…` · dataset sha256 `{off['datasetSha256'][:16]}…`", ""]
    L += ["**How to read this file.** The *final audit* (section 1) is the evidence for any claim: a fresh split (world seeds 60000+, subject seeds 65000+), disjoint from train, validation and the old test split, "
          "evaluated once on the frozen model/calibration with nothing tuned on it. The *development* results (section 2) include the old `test` split (world 40000+/subject 45000+), which was looked at while tuning "
          "earlier model versions, so it is **not** a pristine holdout and is reported as development only.", ""]
    if aoff:
        sp = aoff["split"]
        L += ["## 1. FINAL AUDIT (frozen model, fresh split)", "",
              f"{sp['episodes']} episodes, {sp['samples']} prediction samples ({sp['truthOutsideGrid']} with truth outside the 128 m grid); audit data sha256 `{aoff['datasetAuditSha256'][:16]}…`; model sha256 `{aoff['modelSha256'][:16]}…`.", "",
              "### 1A. Offline prediction metrics (NOT closed-loop)", ""]
        _offline_tables(L, aoff["offline"])
        if acl:
            _closed_section(L, acl, "### 1B. Closed-loop search outcomes (final audit)")
    elif off:
        L += ["## 1. FINAL AUDIT", "", "_Not run for this model yet (`pipeline.audit`)._", ""]
    if off:
        sp = off["splits"]
        L += ["## 2. Development results (train / validation / old test — not a final holdout)", "", "| split | episodes | prediction samples (1 Hz after first fix, while fix missing) | truth outside 128 m grid |", "|---|---|---|---|"]
        for k in ("train", "val", "test"):
            L.append(f"| {k} | {sp[k]['episodes']} | {sp[k]['samples']} | {sp[k]['truthOutsideGrid']} |")
        L += ["", f"Profile `{off['profile']}`, device `{off['device']}`, {off['parameters']:,} parameters, ONNX {off['model_bytes']/1024:.0f} KB. Splits are disjoint in world seed and subject seed.", "",
              "### 2A. Offline (development test split)", ""]
        _offline_tables(L, off["offline_test"])
    if cl:
        _closed_section(L, cl, "### 2B. Closed-loop (development test split)")
    if br:
        L += ["## 3. Browser (real Chromium, onnxruntime-web wasm, single thread)", "",
              f"Model sha256 `{br['modelSha256'][:16]}…`. Model load (fetch + hash + session): {br['loadMs']:.0f} ms. Inference over {br['calls']} calls during the fixed-step precompute: p50 {br['p50Ms']:.2f} ms, p95 {br['p95Ms']:.2f} ms, max {br['maxMs']:.2f} ms. "
              f"Precompute of the full 75 s learned-guidance run: {br['precomputeWallMs']/1000:.1f} s wall. Headless Chromium on the development machine; indicative only. "
              f"Smoke checks: {br.get('checksPassed', '?')} passed, {br.get('checksFailed', '?')} failed (details in `browser_smoke.json`).", ""]
    L += ["## What these results do and do not show", "",
          "* Everything is synthetic simulator data with a hand-written subject; no real-world claim follows.",
          "* The model receives **no start position**: its inputs are noisy observations, the drone's pose, elapsed time and the known map, and it is only run after the first noisy fix. "
          "The drone itself is set up from a coarse 16 m designated area (the same for both guidance modes in the primary comparison).",
          "* The model still learns this simulator's route/goal tendencies and subject habits from data (e.g. from where fixes occur); the Kalman baseline has no such prior, so the comparison is not 'same information'.",
          "* Offline metrics are measured on logs collected under Kalman guidance; closed-loop use is a distribution shift.",
          "* Closed-loop differences are paired by seed, but the subject reacts to the drone so paths diverge; per-group CIs are wide.",
          "* The `turn` group (a jink/feint during the loss) contains nearly every episode, so it is not a discriminating subset.",
          "* The learned 95% region is *validation-calibrated*; the measured coverage on held-out data differs from 95% and is not guaranteed.",
          "* An improvement is claimed only where the bootstrap CI excludes zero; otherwise the text says 'no detectable difference'.", ""]
    path = os.path.join(demo3d_dir, "ml", "RESULTS.md")
    open(path, "w").write("\n".join(L))
    return path
