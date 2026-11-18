"""Local demo page generator: demo/index.html (+ demo/report.html, demo/review_path.html).

Opens from file:// with no server, login, network or extra dependency. Every number on the page
is read from the generated v2 CSV/JSON files at build time and inlined; the page fetches nothing.
No episode is run here.

The two clips are copied byte-for-byte from results/v2/ into demo/ and the players reference the
copies by bare file name. Safari does not render a file:// video that lives outside the page's own
directory (Chrome does), so a "../results/v2/..." source shows a blank rectangle there. The
originals in results/v2/ are only read, and every copy is checked against its original by SHA-256.
"""
from __future__ import annotations

import csv
import hashlib
import html
import json
import shutil
from pathlib import Path

from .analysis import POL_LABEL
from .experiment import ROOT, SCENARIOS
from .v2 import FINAL_POLICIES, FROZEN_V2, LOCK, REFERENCE_ARM, V2_DIR

DEMO_DIR = ROOT / "demo"
REL_V2 = "../results/v2"            # relative path from demo/ to the v2 results (text links only, not media)
NOT_APPLICABLE = "n/a"              # plain label for cells that do not apply (BeliefView compared with itself)
HEADLINE_POLICIES = [p for p in FINAL_POLICIES if p != REFERENCE_ARM]
SUMMARY_COLS = ["scenario", "policy", "n", "found_by_deadline", "found_lo", "found_hi", "n_timeouts", "rmst",
                "mean_distance", "n_subject_exited", "n_unresolved", "n_unres_truth_left", "correct_left",
                "n_unres_truth_inside", "false_left", "mean_p_out", "frac_truth_left", "region_cov_k", "region_cov_n"]
PAIRED_COLS = ["scenario", "baseline", "n_pairs", "d_found", "d_found_lo", "d_found_hi", "d_rmst", "d_rmst_lo",
               "d_rmst_hi", "d_distance", "d_distance_lo", "d_distance_hi", "both_found", "belief_only_found",
               "baseline_only_found", "neither_found"]
TUNING_COLS = ["lam", "n", "n_found", "found_by_deadline", "found_A", "found_B", "mean_distance", "rmst",
               "within_tolerance", "selected"]


def _csv(path, cols):
    with open(path, newline="") as f:
        return [{c: r[c] for c in cols} for r in csv.DictReader(f)]


def load_data(v2_dir: Path = V2_DIR, frozen_path: Path = FROZEN_V2, lock_path: Path = LOCK) -> dict:
    """All data shown on the page. CSV cells are kept as the exact strings in the CSV files."""
    frozen = json.loads(Path(frozen_path).read_text())
    lock = json.loads(Path(lock_path).read_text())
    meta = json.loads((v2_dir / "animation_meta.json").read_text())
    return {
        "protocol": {"lam": frozen["chosen"]["lam"], "config_hash": frozen["config_hash"],
                     "protocol_hash": frozen["protocol_hash"], "core_source_checksum": frozen["core_source_checksum"],
                     "split_ids": frozen["protocol"]["split_ids"],
                     "n_val_per_scenario": frozen["tuning_log"]["n_per_scenario"],
                     "lam_grid": frozen["protocol"]["tuning"]["lam_grid"],
                     "tolerance": frozen["protocol"]["tuning"]["tolerance"],
                     "tau_left": frozen["chosen"]["tau_left"],
                     "final_started_at": lock["started_at"], "final_completed_at": lock["completed_at"]},
        "summary": _csv(v2_dir / "summary_by_scenario.csv", SUMMARY_COLS),
        "paired": _csv(v2_dir / "paired_differences.csv", PAIRED_COLS),
        "tuning": _csv(v2_dir / "validation_tuning.csv", TUNING_COLS),
        "episodes": meta["episodes"],
    }


# ---------------------------------------------------------------- formatting (shared with the tests)
def f2(s) -> str:
    return f"{float(s):.2f}"


def f1(s) -> str:
    return f"{float(s):.1f}"


def found_ci(r) -> str:
    return f"{f2(r['found_by_deadline'])} [{f2(r['found_lo'])}, {f2(r['found_hi'])}]"


def diff_ci(r, key, digits=2) -> str:
    return (f"{float(r[key]):+.{digits}f} [{float(r[key + '_lo']):+.{digits}f}, "
            f"{float(r[key + '_hi']):+.{digits}f}]")


def excludes_zero(r, key) -> bool:
    return float(r[key + "_lo"]) > 0 or float(r[key + "_hi"]) < 0


def scen_label(name: str) -> str:
    return name.replace("_", " ")


def _table(header, rows, cls=""):
    e = html.escape
    out = [f'<div class="scroll"><table class="{cls}"><thead><tr>' + "".join(f"<th>{e(h)}</th>" for h in header)
           + "</tr></thead><tbody>"]
    for row in rows:
        out.append("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>")
    out.append("</tbody></table></div>")
    return "\n".join(out)


CSS = """
:root { color-scheme: light dark; --fg:#1b1b1b; --bg:#fbfbf9; --mut:#5c5c5c; --line:#d5d5d0; --card:#ffffff; --warn:#8a4b00; --acc:#0072B2; }
@media (prefers-color-scheme: dark) { :root { --fg:#e9e9e6; --bg:#17181a; --mut:#a5a5a0; --line:#3a3b3e; --card:#1f2023; --warn:#f0b35c; --acc:#6cb8e6; } }
* { box-sizing: border-box; }
body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); margin: 0; }
main { max-width: 1180px; margin: 0 auto; padding: 20px 20px 60px; }
h1 { font-size: 1.6rem; margin: 0.2em 0; } h2 { font-size: 1.2rem; margin: 1.8em 0 0.4em; border-top: 1px solid var(--line); padding-top: 0.9em; }
h3 { font-size: 1rem; margin: 1.1em 0 0.3em; }
p, li { max-width: 78ch; } .mut { color: var(--mut); } .small { font-size: 0.86rem; }
.banner { border: 1px solid var(--warn); color: var(--warn); border-radius: 6px; padding: 8px 12px; margin: 10px 0; font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 12px 0; }
.scroll { overflow-x: auto; } table { border-collapse: collapse; font-size: 0.88rem; margin: 8px 0; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; white-space: nowrap; } th { white-space: normal; min-width: 9ch; vertical-align: bottom; background: color-mix(in srgb, var(--line) 35%, transparent); }
td.wrap { white-space: normal; min-width: 18ch; } tr.hl td { font-weight: 600; }
.tag { display: inline-block; border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; font-size: 0.78rem; color: var(--mut); }
.tag.no { border-color: var(--warn); color: var(--warn); }
video { width: 100%; max-width: 900px; background: #fff; border: 1px solid var(--line); border-radius: 4px; display: block; }
.ctl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; max-width: 900px; }
.ctl input[type=range] { flex: 1 1 260px; } button, select { font: inherit; padding: 4px 10px; border-radius: 5px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
.readout { font-family: ui-monospace, Menlo, monospace; font-size: 0.86rem; }
dl.legend { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; max-width: 900px; } dl.legend dt { font-weight: 600; } dl.legend dd { margin: 0; }
.sw { display: inline-block; width: 0.9em; height: 0.9em; vertical-align: -0.1em; margin-right: 5px; border: 1px solid #0006; }
a { color: var(--acc); } pre { white-space: pre; overflow-x: auto; font-size: 0.8rem; line-height: 1.35; }
"""

JS = """
(function () {
  var data = JSON.parse(document.getElementById('bv-data').textContent);
  data.episodes.forEach(function (ep) {
    var root = document.getElementById('player-' + ep.kind);
    var v = root.querySelector('video'), slider = root.querySelector('input[type=range]');
    var play = root.querySelector('.play'), out = root.querySelector('.readout');
    var n = ep.n_frames, fps = ep.fps;
    function frameOf(t) { return Math.max(0, Math.min(n - 1, Math.floor(t * fps + 1e-6))); }
    function show(k) {
      var f = ep.frames[k];
      slider.value = k;
      out.textContent = 'frame ' + (k + 1) + ' of ' + n + '   step t = ' + f.t + '   P(outside) = ' + f.p_out.toFixed(2) +
        '   new look: ' + (f.look ? 'yes' : 'no') + '   detected: ' + (f.detected ? 'YES' : 'no') +
        '   [evaluation-only] subject ' + (f.subject_inside ? 'inside' : 'has left the area');
    }
    function seek(k) { k = Math.max(0, Math.min(n - 1, k)); v.pause(); v.currentTime = (k + 0.5) / fps; show(k); }
    play.addEventListener('click', function () {
      if (v.paused) { if (v.ended || frameOf(v.currentTime) >= n - 1) { v.currentTime = 0; } v.play(); } else { v.pause(); }
    });
    v.addEventListener('play', function () { play.textContent = 'Pause'; });
    v.addEventListener('pause', function () { play.textContent = 'Play'; });
    v.addEventListener('timeupdate', function () { show(frameOf(v.currentTime)); });
    (function tick() { if (!v.paused) { show(frameOf(v.currentTime)); } window.requestAnimationFrame(tick); })();
    slider.addEventListener('input', function () { seek(parseInt(slider.value, 10)); });
    root.querySelector('.prev').addEventListener('click', function () { seek(parseInt(slider.value, 10) - 1); });
    root.querySelector('.next').addEventListener('click', function () { seek(parseInt(slider.value, 10) + 1); });
    root.querySelector('.rate').addEventListener('change', function (e) { v.playbackRate = parseFloat(e.target.value); });
    v.playbackRate = 0.5;
    show(0);
  });
})();
"""


def media_name(ep) -> str:
    """File name of a clip's in-demo copy: a bare name, so the player source stays inside demo/."""
    name = ep["file"]
    if Path(name).name != name or not name.endswith(".mp4"):
        raise ValueError(f"unexpected clip file name: {name!r}")
    return name


def _sha256(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def copy_media(episodes, v2_dir: Path = V2_DIR, demo_dir: Path = DEMO_DIR) -> list:
    """Copy each clip from v2_dir into demo_dir and verify the copy byte-matches its original.
    The originals are opened for reading only. Returns [(name, sha256), ...]."""
    out = []
    for ep in episodes:
        name = media_name(ep)
        src, dst = Path(v2_dir) / name, Path(demo_dir) / name
        want = _sha256(src)
        if not (dst.is_file() and _sha256(dst) == want):
            shutil.copyfile(src, dst)
        got = _sha256(dst)
        if got != want or _sha256(src) != want:
            raise RuntimeError(f"demo copy of {name} does not byte-match {src}")
        out.append((name, got))
    return out


def _player(ep) -> str:
    e = html.escape
    if ep["found"]:
        outcome = f"reacquired at step {ep['t_detect']}"
    else:
        where = "had left the area" if ep["truth_left"] else "was still inside the area"
        call = ("the deadline report declared &quot;left the area&quot;" if ep["declared_left"]
                else "the deadline report did not declare &quot;left the area&quot;")
        wrong = ""
        if ep["declared_left"] and not ep["truth_left"]:
            wrong = " <strong>That declaration was wrong.</strong>"
        outcome = (f"not reacquired by the deadline; final stated P(outside) = {ep['p_out_final']:.2f}; the subject "
                   f"{where} (evaluation-only truth); {call}.{wrong}")
    rule = ("a scenario A BeliefView success whose detection time is the median of the successes"
            if ep["kind"] == "representative" else
            "the first motion-mismatch (scenario B) BeliefView timeout whose subject was still inside the area")
    return f"""
<div class="card" id="player-{e(ep['kind'])}">
  <h3>{e(ep['kind'].capitalize())} clip: {e(scen_label(ep['scenario']))}, v2 final episode {ep['idx']}</h3>
  <p class="small"><span class="tag">illustrative episode, selected by outcome</span> Selection rule: {rule}.
  One episode is not evidence about rates; the tables below are. True behaviour (evaluation-only): {e(ep['behavior'])}.
  Outcome: {outcome}</p>
  <video src="{e(media_name(ep))}" preload="auto" playsinline muted></video>
  <div class="ctl">
    <button class="play" type="button">Play</button>
    <button class="prev" type="button" aria-label="Back one frame">&#9664; 1 frame</button>
    <button class="next" type="button" aria-label="Forward one frame">1 frame &#9654;</button>
    <input type="range" min="0" max="{ep['n_frames'] - 1}" step="1" value="0" aria-label="Seek by frame">
    <label class="small">speed <select class="rate"><option value="0.25">0.25x</option><option value="0.5" selected>0.5x</option><option value="1">1x</option></select></label>
  </div>
  <div class="readout" aria-live="off">frame 1 of {ep['n_frames']}</div>
  <p class="small mut">One frame = one simulation step ({ep['n_frames']} frames). The step slider and frame buttons pause the clip.</p>
</div>"""


def render_index(d: dict) -> str:
    e = html.escape
    P = d["protocol"]
    lam = f"{P['lam']:g}"
    S = {(r["scenario"], r["policy"]): r for r in d["summary"]}
    D = {(r["scenario"], r["baseline"]): r for r in d["paired"]}
    scen = [s.name for s in SCENARIOS]
    n = S[(scen[0], "belief")]["n"]
    A = "A_matched"
    B = "B_motion_mismatch"

    def tag(r, key):
        return ('<span class="tag">interval excludes 0</span>' if excludes_zero(r, key)
                else '<span class="tag no">not distinguishable (interval includes 0)</span>')

    # matched case, per policy
    rowsA = []
    for p in HEADLINE_POLICIES:
        r = S[(A, p)]
        if p == "belief":
            cells = [NOT_APPLICABLE, NOT_APPLICABLE, ""]
        else:
            dd = D[(A, p)]
            cells = [diff_ci(dd, "d_found"), diff_ci(dd, "d_distance", 1), tag(dd, "d_found")]
        rowsA.append((p == "belief", [e(POL_LABEL[p]), found_ci(r), f1(r["rmst"]), f1(r["mean_distance"])] + cells))
    tabA = _table(["policy", "reacquired by deadline [95% CI]", "RMST (steps)", "mean travel (units)",
                   "BeliefView minus this: reacquired [95% CI]", "BeliefView minus this: travel [95% CI]", ""],
                  [c for _, c in rowsA]).replace("<tr><td>" + e(POL_LABEL["belief"]), '<tr class="hl"><td>' + e(POL_LABEL["belief"]))

    # all four scenarios: reacquired and travel per policy
    tab4 = _table(["scenario"] + [POL_LABEL[p] for p in HEADLINE_POLICIES],
                  [[e(scen_label(s))] + [f"{f2(S[(s, p)]['found_by_deadline'])} &nbsp;<span class='mut'>travel {f1(S[(s, p)]['mean_distance'])}</span>"
                                         for p in HEADLINE_POLICIES] for s in scen])

    def diff_table(base, first_col):
        return _table(["scenario", first_col, "", "RMST difference [95% CI]", "travel difference [95% CI]",
                       "both / only BeliefView / only other / neither"],
                      [[e(scen_label(s)), diff_ci(D[(s, base)], "d_found"), tag(D[(s, base)], "d_found"),
                        diff_ci(D[(s, base)], "d_rmst", 1), diff_ci(D[(s, base)], "d_distance", 1),
                        " / ".join(D[(s, base)][k] for k in ("both_found", "belief_only_found", "baseline_only_found", "neither_found"))]
                       for s in scen])

    tab_ls = diff_table("last_seen", "BeliefView minus Last-seen: reacquired [95% CI]")
    tab_abl = diff_table("belief_noneg", "BeliefView minus no-miss-update ablation: reacquired [95% CI]")
    tab_ref = diff_table(REFERENCE_ARM, f"BeliefView (lam = {lam}) minus lam = 0 reference: reacquired [95% CI]")
    n_ls_indist = sum(not excludes_zero(D[(s, "last_seen")], "d_found") for s in scen)
    n_abl_indist = sum(not excludes_zero(D[(s, "belief_noneg")], "d_found") for s in scen)
    n_ref_indist = sum(not excludes_zero(D[(s, REFERENCE_ARM)], "d_found") for s in scen)
    n_ref_less = sum(float(D[(s, REFERENCE_ARM)]["d_distance_hi"]) < 0 for s in scen)

    tab_tune = _table(["lam", "reacquired, A+B", "A", "B", "mean travel", "within 0.03 of best", "selected"],
                      [[f"{float(r['lam']):g}", f"{float(r['found_by_deadline']):.3f} ({r['n_found']} of {r['n']})",
                        f2(r["found_A"]), f2(r["found_B"]), f1(r["mean_distance"]),
                        "yes" if r["within_tolerance"] == "True" else "no",
                        "<strong>selected</strong>" if r["selected"] == "True" else ""] for r in d["tuning"]])

    tab_out = _table(["scenario", "subjects that left the map", "unresolved runs", "correct &quot;left&quot; calls",
                      "false &quot;left&quot; calls (subject still inside)", "mean stated P(outside)", "fraction that had actually left",
                      "90% in-area region held the subject"],
                     [[e(scen_label(s)), f"{S[(s, 'belief')]['n_subject_exited']} of {S[(s, 'belief')]['n']}",
                       S[(s, "belief")]["n_unresolved"],
                       f"{S[(s, 'belief')]['correct_left']} of {S[(s, 'belief')]['n_unres_truth_left']}",
                       f"{S[(s, 'belief')]['false_left']} of {S[(s, 'belief')]['n_unres_truth_inside']}",
                       f2(S[(s, "belief")]["mean_p_out"]), f2(S[(s, "belief")]["frac_truth_left"]),
                       f"{S[(s, 'belief')]['region_cov_k']} of {S[(s, 'belief')]['region_cov_n']}"] for s in scen])
    tab_out = tab_out.replace("&amp;quot;", "&quot;")

    eps = {ep["kind"]: ep for ep in d["episodes"]}
    bB, lsB, dB = S[(B, "belief")], S[(B, "last_seen")], D[(B, "last_seen")]
    ratios = [float(S[(s, "belief")]["mean_distance"]) / float(S[(s, "last_seen")]["mean_distance"]) for s in scen]
    fe = eps["failure"]
    if fe["declared_left"] and not fe["truth_left"]:
        clip_note = (f"The failure clip above (episode {fe['idx']}) is one of those wrong declarations: final stated "
                     f"P(outside) = {fe['p_out_final']:.2f} with the subject still inside.")
    else:
        clip_note = (f"The failure clip above ({e(scen_label(fe['scenario']))}, episode {fe['idx']}) is a plain miss rather than a wrong "
                     f"declaration: the subject (true behaviour: {e(fe['behavior'])}) "
                     f"{'had left' if fe['truth_left'] else 'was still inside'} at the deadline, was never detected, and the final stated "
                     f"P(outside) was {fe['p_out_final']:.2f}, so no &quot;left&quot; call was made. It was picked by the fixed rule "
                     "(first such episode), not because it shows the wrong-declaration failure.")
    blob = json.dumps(d, separators=(",", ":")).replace("</", "<\\/")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BeliefView v2: local demo (synthetic 2D simulation)</title>
<style>{CSS}</style>
</head>
<body>
<main>
<h1>BeliefView v2: local demo</h1>
<div class="banner">Synthetic 2D simulation only. No real drone, camera, flight controller or real-world validation is involved, and nothing here predicts real drone performance.</div>
<p>An observer &quot;drone&quot; loses a moving subject behind cover. It keeps a probability map of where the subject might be,
including a chance that it left the search area, updates that map when it looks and sees nothing, and greedily (not optimally)
picks its next viewpoint. It is compared with simple search patterns on the same pre-rolled episodes.</p>
<p class="small mut">AI assistance: the code was written by Claude (initial implementation attributed to Claude Sonnet 5.5; the fix pass,
the v2 protocol and this page by Claude Fable 5.2). Codex orchestrates and reviews independently. This page is generated from the result
files and makes no claim about what Reid has personally verified; that checklist is in the review path and is his to complete.
See <a href="../CONTRIBUTIONS.md">CONTRIBUTIONS.md</a>.</p>
<p class="small">Full report: <a href="report.html">v2 results (all tables)</a> &middot; <a href="{REL_V2}/results.md">results.md</a> &middot;
<a href="../README.md">README.md</a> &middot; Four-hour review path: <a href="review_path.html">review_path.html</a> &middot;
<a href="../REVIEW_PATH.md">REVIEW_PATH.md</a></p>

<h2>1. Two clips you can pause and scrub</h2>
<p>Both clips show BeliefView (travel penalty lam = {lam}). They were chosen by their outcome to illustrate one ordinary success and
one failure; they are not a sample of typical behaviour.</p>
{_player(eps['representative'])}
{_player(eps['failure'])}

<h3>What the picture shows</h3>
<dl class="legend">
<dt><span class="sw" style="background:linear-gradient(90deg,#fcfdbf,#b5367a,#000004)"></span>Heatmap</dt>
<dd>The filter's probability that the subject is in each cell, on the same fixed colour scale (0 to 0.05) in every frame. It is the
unconditional probability and is never renormalised, so the map fades as probability moves to &quot;outside&quot;.</dd>
<dt><span class="sw" style="background:#0072B2"></span>Outside bar</dt>
<dd>P(outside): the filter's probability that the subject has left the 40 x 40 search area. Map plus bar always sum to 1.</dd>
<dt><span class="sw" style="background:#56B4E9"></span>Blue wedge and dot</dt>
<dd>The observer and its 60-degree, range-12 field of view. The wedge is brighter on steps that count as a new independent look.</dd>
<dt><span class="sw" style="background:#74c476;border-radius:50%"></span>Candidate viewpoints</dt>
<dd>Small circles: the places the greedy planner scored at its latest planning step (darker green = higher score =
P(reacquire within 12 steps) minus lam x travel steps). The green star and line are the single best candidate and the path to it.</dd>
<dt><span class="sw" style="background:transparent;border:2px solid #D55E00;transform:rotate(45deg)"></span>Evaluation-only truth</dt>
<dd>The orange diamond is the subject's true position. It is drawn for the viewer and for scoring only. The filter and planner
never receive it: they get the observer's own pose, one noisy last-seen point and its age, and for each look a detect / no-detect
flag (with a noisy position on a detection). The line under each clip marked [evaluation-only] is likewise not planner input.</dd>
<dt><span class="sw" style="background:#F0E442"></span>Yellow star</dt>
<dd>A detection (the simulated sensor has no false positives, so a detection is always the subject).</dd>
</dl>

<h2>2. Matched case (scenario A): paired comparison</h2>
<p>{n} fresh final episodes, run once; every policy ran the same episodes. Intervals are 95% bootstrap intervals and are
<strong>not adjusted</strong> for the number of comparisons on this page. Travel is distance flown until first detection or the deadline.</p>
{tabA}

<h2>3. All four scenarios</h2>
<p>Fraction reacquired by the deadline, with mean travel beside it ({n} final episodes per scenario). B, C and D deliberately
break one of the filter's assumptions (motion, sensor, exit rate). Full tables with intervals are in the <a href="report.html">report</a>.</p>
{tab4}
<h3>Against the simple &quot;go to the last-seen point and scan&quot; baseline</h3>
<p>BeliefView was not statistically distinguishable from this baseline on reacquisition in {n_ls_indist} of {len(scen)} scenarios
(interval includes 0), and the travel column shows what BeliefView's extra flying cost.</p>
{tab_ls}
<h3>Do the miss updates matter? (clean ablation: same planner and lam, misses not used)</h3>
<p>Using misses to update the belief made no statistically distinguishable difference to reacquisition in {n_abl_indist} of
{len(scen)} scenarios in this run (interval includes 0).</p>
{tab_abl}
<h3>What the positive travel penalty did (lam = {lam} versus the lam = 0 reference arm)</h3>
<p>The reference arm is BeliefView with lam = 0 on the same final episodes. It is a labelled reference only: it was not a tuning
candidate and is not a headline result. A negative travel difference means the penalty saved flying; a negative reacquired
difference means it cost reacquisitions. The penalty reduced travel in {n_ref_less} of {len(scen)} scenarios (interval below 0);
reacquisition was not distinguishable from the reference arm in {n_ref_indist} of {len(scen)}.</p>
{tab_ref}
<h3>How lam = {lam} was chosen</h3>
<p>On {P['n_val_per_scenario']} separate validation episodes in each of scenarios A and B, by a rule fixed before any v2 episode
existed: the largest lam on the grid whose combined reacquired fraction is within {P['tolerance']} of the grid's best.</p>
{tab_tune}

<h2>4. The motion-mismatch failure</h2>
<p>In scenario B the subject makes long stops and doubles back, while the filter still assumes short stops and rare reversals.
There BeliefView reacquired {f2(bB['found_by_deadline'])} of subjects against {f2(lsB['found_by_deadline'])} for Last-seen
(difference {diff_ci(dB, 'd_found')}; {'interval excludes 0' if excludes_zero(dB, 'd_found') else 'not distinguishable'}) while flying
{f1(bB['mean_distance'])} units against {f1(lsB['mean_distance'])}: the belief machinery
{'did better than' if excludes_zero(dB, 'd_found') and float(dB['d_found']) > 0 else 'bought nothing measurable over'} the simple baseline
here, at {float(bB['mean_distance']) / float(lsB['mean_distance']):.1f} times the travel.</p>
<p>Its deadline report was also unreliable under this mismatch: among unresolved scenario B runs whose subject was still inside,
it wrongly declared &quot;left the area&quot; in {bB['false_left']} of {bB['n_unres_truth_inside']}, and it correctly declared
&quot;left&quot; for only {bB['correct_left']} of the {bB['n_unres_truth_left']} that had left. {clip_note}</p>
<p>BeliefView's deadline report in every scenario (declares &quot;left&quot; when P(outside) is at least {P['tau_left']}):</p>
{tab_out}

<h2>5. Limitations</h2>
<ul>
<li><strong>Simulation only.</strong> One fixed 40 x 40 map of rectangles, an abstract 2D sensor model, hand-written subject
behaviours, perfect self-pose, no altitude, camera projection, wind, latency or battery.</li>
<li><strong>No false positives.</strong> The simulated sensor never reports a subject that is not there. Real detectors do.</li>
<li><strong>Many true exits.</strong> {", ".join(f"{S[(s, 'belief')]['n_subject_exited']} of {S[(s, 'belief')]['n']} ({scen_label(s)})" for s in scen)}
subjects leave the map before the deadline, which caps every method's reacquisition rate.</li>
<li><strong>Small still-inside denominators.</strong> False-&quot;left&quot; rates and region coverage rest on
{", ".join(S[(s, 'belief')]['n_unres_truth_inside'] for s in scen)} still-inside unresolved runs (A, B, C, D): too few to estimate a rate.</li>
<li><strong>Unadjusted intervals.</strong> Many comparisons are shown; some intervals would exclude 0 by chance alone.</li>
<li><strong>Travel cost.</strong> BeliefView flies {min(ratios):.1f} to {max(ratios):.1f} times as far as Last-seen across the four scenarios (section 3).</li>
<li><strong>Greedy planner.</strong> One-step choice among a small candidate set; not globally optimal.</li>
<li><strong>v1 is an earlier record, not this result.</strong> v1 used lam = 0 (the travel penalty was inactive) and its 100 test
episodes per scenario were run twice. It is kept unmodified in <a href="../results/results.md">results/</a> and
<a href="../archive/v1/MANIFEST.sha256">archive/v1/</a> and its tables are not merged with v2.</li>
</ul>

<h2>Provenance</h2>
<p class="small mut">v2 config hash {e(P['config_hash'])}, protocol hash {e(P['protocol_hash'])}, core source checksum {e(P['core_source_checksum'])}.
Validation split id {P['split_ids']['v2_val']}, final split id {P['split_ids']['v2_final']}. Final run started {e(str(P['final_started_at']))},
completed {e(str(P['final_completed_at']))}; run once. Numbers on this page were read from
<code>results/v2/summary_by_scenario.csv</code>, <code>paired_differences.csv</code>, <code>validation_tuning.csv</code> and
<code>animation_meta.json</code> when the page was generated (<code>python -m beliefview.cli demo</code>).</p>
</main>
<script id="bv-data" type="application/json">{blob}</script>
<script>{JS}</script>
</body>
</html>
"""


def render_text_page(title: str, source_rel: str, text: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>{CSS}</style>
</head>
<body>
<main>
<p class="small"><a href="index.html">&larr; back to the demo</a> &middot; plain-text copy of <a href="{html.escape(source_rel)}">{html.escape(source_rel)}</a>, inlined when the demo was generated</p>
<div class="banner">Synthetic 2D simulation only. Not a result about any real drone.</div>
<pre>{html.escape(text)}</pre>
</main>
</body>
</html>
"""


def render_all(v2_dir: Path = V2_DIR) -> dict:
    d = load_data(v2_dir)
    return {
        "index.html": render_index(d),
        "report.html": render_text_page("BeliefView v2 results (full report)", f"{REL_V2}/results.md",
                                        (v2_dir / "results.md").read_text()),
        "review_path.html": render_text_page("BeliefView four-hour review path", "../REVIEW_PATH.md",
                                             (ROOT / "REVIEW_PATH.md").read_text()),
    }


def build_demo() -> Path:
    DEMO_DIR.mkdir(exist_ok=True)
    copy_media(load_data()["episodes"])                # byte-matching in-demo copies of both clips
    for name, text in render_all().items():
        (DEMO_DIR / name).write_text(text)
    return DEMO_DIR / "index.html"
