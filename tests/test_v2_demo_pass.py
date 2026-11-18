"""Tests added in the v2 / local demo pass. Each covers one concrete risk:

1. the v1 record (archive and live copy) silently changing;
2. the ablation or the reference arm not running with the intended travel penalty;
3. v2 episodes not being fresh streams (or the wrong split/count being reported);
4. the demo showing numbers that are not the generated results;
5. the demo depending on anything remote;
6. the demo clips living outside demo/ (Safari shows such a file:// video blank) or drifting from
   the result clips they were copied from.

They read the frozen v2 config, the saved v2 records and the generated demo; they run no
validation or final episode.
"""
import csv
import dataclasses
import hashlib
import json
import re
from pathlib import Path

import numpy as np

from beliefview import demo, experiment, v2
from beliefview.belief import GridGeometry
from beliefview.config import config_hash
from beliefview.experiment import SCENARIOS, build_config, load_records, make_policy
from beliefview.world import SPLITS, make_episode

ROOT = Path(__file__).resolve().parent.parent
ARCH = ROOT / "archive" / "v1"
V1_HASH = "222bce7e37097894"


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


# ------------------------------------------------------------------ 1. v1 archive integrity
def test_v1_archive_and_live_v1_record_match_the_checksum_manifest():
    man = dict(reversed(line.split("  ", 1)) for line in (ARCH / "MANIFEST.sha256").read_text().splitlines())
    assert len(man) == 15 and "config/frozen.json" in man and "results/test_records.jsonl" in man
    on_disk = sorted(str(p.relative_to(ARCH)) for d in ("config", "results") for p in (ARCH / d).rglob("*") if p.is_file())
    assert on_disk == sorted(man)                      # nothing added to or removed from the archive
    for rel, digest in man.items():
        assert _sha(ARCH / rel) == digest, f"archive copy changed: {rel}"
        assert _sha(ROOT / rel) == digest, f"live v1 record changed: {rel}"
    frozen = json.loads((ARCH / "config" / "frozen.json").read_text())
    assert frozen["config_hash"] == V1_HASH and frozen["chosen"]["lam"] == 0.0
    # the v1 reproduction command still builds exactly the v1 configuration from today's code
    assert config_hash(build_config(frozen["chosen"])) == V1_HASH
    assert experiment.load_frozen() == frozen


# ------------------------------------------------------------------ 2. clean shared-lambda ablation
def test_selection_rule_takes_the_largest_lam_within_tolerance_inclusive():
    c = lambda k: {"n_found": k, "n": 200}
    # best 0.50; 0.002 is exactly 0.03 below (eligible), 0.004 is 0.035 below (not)
    assert v2.select_lam({0.0005: c(100), 0.001: c(97), 0.002: c(94), 0.004: c(93)}, 0.03) == 0.002
    assert v2.select_lam({0.0005: c(90), 0.001: c(100), 0.002: c(80), 0.004: c(70)}, 0.03) == 0.001


def test_v2_ablation_inherits_the_selected_positive_lam_and_reference_arm_is_only_lam0(m, nav):
    frozen = v2.load_frozen_v2()
    cfg = v2.verify_frozen_v2(frozen, check_source=False)
    grid = v2.PROTOCOL["tuning"]["lam_grid"]
    lam = frozen["chosen"]["lam"]
    assert grid == [0.0005, 0.001, 0.002, 0.004] and lam in grid and lam > 0
    tl = frozen["tuning_log"]
    assert sorted(float(k) for k in tl["candidates"]) == grid          # lam = 0 was never a candidate
    assert v2.select_lam(tl["candidates"], 0.03) == lam == tl["selected_lam"]   # the recorded rates give the recorded choice
    assert {k: frozen["chosen"][k] for k in v2.FIXED_FROM_V1} == {"orbit_margin": 2.0, "scan_yaw_deg": 45.0, "tau_left": 0.9}

    geo = GridGeometry(m)
    spec = SCENARIOS[0]
    a, b, ref = (make_policy(p, cfg, spec, geo, nav) for p in ("belief", "belief_noneg", "belief_lam0"))
    assert a.pp is b.pp is cfg.planner and a.pp.lam == lam               # one settings object
    assert (a.filter.skip_miss, b.filter.skip_miss, ref.filter.skip_miss) == (False, True, False)
    assert ref.pp == dataclasses.replace(cfg.planner, lam=0.0) and ref.name == "belief_lam0"
    assert "belief_lam0" not in experiment.POLICIES and v2.PROTOCOL["tuning"]["policy"] == "belief"

    # what actually ran, from the saved records
    val = load_records(v2.V2_DIR / "validation_records.jsonl")
    assert {r["policy"] for r in val} == {"belief"} and sorted({r["planner_lam"] for r in val}) == grid
    want = {"belief": lam, "belief_noneg": lam, "belief_lam0": 0.0, "stay": None, "last_seen": None, "orbit": None}
    final = load_records(v2.V2_DIR / "final_records.jsonl")
    assert {r["policy"] for r in final} == set(want)
    assert all(r["planner_lam"] == want[r["policy"]] for r in final)
    # the validation rates in the frozen file are the rates in the validation records
    for k, c in tl["candidates"].items():
        rs = [r for r in val if r["planner_lam"] == float(k)]
        assert (len(rs), sum(r["found"] for r in rs)) == (c["n"], c["n_found"]) == (200, c["n_found"])


# ------------------------------------------------------------------ 3. fresh split mapping
def test_v2_uses_fresh_split_ids_and_the_specified_counts(m, nav):
    assert SPLITS == {"dev": 0, "val": 1, "test": 2, "v2_val": 3, "v2_final": 4}
    frozen = v2.load_frozen_v2()
    assert frozen["protocol"]["split_ids"] == {"v2_val": 3, "v2_final": 4}
    base = frozen["base_seed"]
    eps = {s: make_episode(SCENARIOS[0], 0, s, 0, base, m, nav, 20) for s in SPLITS}
    names = list(SPLITS)
    for i, s in enumerate(names):                      # same scenario and index, different stream per split
        for t in names[i + 1:]:
            assert eps[s].lost_xy != eps[t].lost_xy and not np.array_equal(eps[s].u, eps[t].u), (s, t)

    scen = [s.name for s in SCENARIOS]
    final = load_records(v2.V2_DIR / "final_records.jsonl")
    sweep = load_records(v2.V2_DIR / "exit_sweep_records.jsonl")
    val = load_records(v2.V2_DIR / "validation_records.jsonl")
    assert {r["split"] for r in final + sweep} == {"v2_final"} and {r["split"] for r in val} == {"v2_val"}
    for sc in scen:
        for p in v2.FINAL_POLICIES:
            assert sorted(r["idx"] for r in final if r["scenario"] == sc and r["policy"] == p) == list(range(200))
    assert len(final) == 4 * 200 * 6
    assert {r["scenario"] for r in val} == {"A_matched", "B_motion_mismatch"}
    for sc in ("A_matched", "B_motion_mismatch"):
        for lam in v2.PROTOCOL["tuning"]["lam_grid"]:
            assert sorted(r["idx"] for r in val if r["scenario"] == sc and r["planner_lam"] == lam) == list(range(100))
    # a recorded final episode really is the split-4 stream: its behaviour label replays from the seed mapping
    for r in final[:12]:
        i = scen.index(r["scenario"])
        assert make_episode(SCENARIOS[i], i, "v2_final", r["idx"], base, m, nav, 80).behavior == r["behavior"]
    lock = json.loads(v2.LOCK.read_text())
    assert lock["split_id"] == 4 and lock["n_per_scenario"] == 200 and lock["completed_at"]
    assert lock["protocol_hash"] == frozen["protocol_hash"] and lock["core_source_checksum"] == frozen["core_source_checksum"]
    assert frozen["frozen_at"] <= lock["started_at"]   # frozen before the final run started


# ------------------------------------------------------------------ 4. demo generator data consistency
def _index():
    return (demo.DEMO_DIR / "index.html").read_text()


def test_demo_pages_are_current_and_show_the_generated_v2_numbers():
    for name, text in demo.render_all().items():       # the committed pages are what the generator produces now
        assert (demo.DEMO_DIR / name).read_text() == text, f"demo/{name} is stale: run `make demo`"
    page = _index()
    blob = re.search(r'<script id="bv-data" type="application/json">(.*?)</script>', page, re.S).group(1)
    data = json.loads(blob.replace("<\\/", "</"))
    with open(v2.V2_DIR / "summary_by_scenario.csv", newline="") as f:
        summ = {(r["scenario"], r["policy"]): r for r in csv.DictReader(f)}
    with open(v2.V2_DIR / "paired_differences.csv", newline="") as f:
        paired = {(r["scenario"], r["baseline"]): r for r in csv.DictReader(f)}
    for r in data["summary"]:                          # inlined cells are the CSV cells, verbatim
        assert all(summ[(r["scenario"], r["policy"])][k] == v for k, v in r.items())
    for r in data["paired"]:
        assert all(paired[(r["scenario"], r["baseline"])][k] == v for k, v in r.items())
    assert len(data["summary"]) == len(summ) == 24 and len(data["paired"]) == len(paired) == 20

    # independent recomputation from the raw per-episode records for what the tables display
    recs = load_records(v2.V2_DIR / "final_records.jsonl")
    by = {}
    for r in recs:
        by.setdefault((r["scenario"], r["policy"]), {})[r["idx"]] = r
    for (sc, p), eps in by.items():
        found = np.mean([e["found"] for e in eps.values()])
        dist = np.mean([e["distance"] for e in eps.values()])
        assert abs(float(summ[(sc, p)]["found_by_deadline"]) - found) < 1e-4
        assert abs(float(summ[(sc, p)]["mean_distance"]) - dist) < 1e-4
        if p in demo.HEADLINE_POLICIES:                # the all-scenarios table cell
            assert f"{found:.2f} &nbsp;<span class='mut'>travel {dist:.1f}</span>" in page
        if p != "belief":
            b = by[(sc, "belief")]
            d_found = np.mean([float(b[i]["found"]) - float(eps[i]["found"]) for i in eps])
            d_dist = np.mean([b[i]["distance"] - eps[i]["distance"] for i in eps])
            row = paired[(sc, p)]
            assert abs(float(row["d_found"]) - d_found) < 1e-4 and abs(float(row["d_distance"]) - d_dist) < 1e-4
            if p in ("last_seen", "belief_noneg", "belief_lam0"):   # shown for all four scenarios
                assert demo.diff_ci(row, "d_found") in page and demo.diff_ci(row, "d_distance", 1) in page
            if sc == "A_matched" and p in demo.HEADLINE_POLICIES:  # matched-case table
                assert demo.diff_ci(row, "d_found") in page
    for p in demo.HEADLINE_POLICIES:
        assert demo.found_ci(summ[("A_matched", p)]) in page

    frozen = v2.load_frozen_v2()
    assert f"lam = {frozen['chosen']['lam']:g}" in page and frozen["protocol_hash"] in page
    for ep in data["episodes"]:                        # the clips are the recorded episodes
        rec = by[(ep["scenario"], "belief")][ep["idx"]]
        assert ep["split"] == "v2_final" and ep["found"] == rec["found"] and ep["t_detect"] == rec["t_detect"]
        assert ep["n_frames"] == len(ep["frames"]) == rec["steps"] and (v2.V2_DIR / ep["file"]).is_file()
        assert f'id="player-{ep["kind"]}"' in page and f"v2 final episode {ep['idx']}" in page
    assert page.count("illustrative episode, selected by outcome") == 2
    assert "Synthetic 2D simulation only" in page and "[evaluation-only]" in page


# ------------------------------------------------------------------ 5. no remote assets
def test_demo_uses_only_relative_local_assets():
    pages = sorted(demo.DEMO_DIR.glob("*.html"))
    assert [p.name for p in pages] == ["index.html", "report.html", "review_path.html"]
    for p in pages:
        text = p.read_text()
        for bad in ("http://", "https://", "//cdn", "@import", "url(", "<link", "<iframe", "<object", "<embed",
                    "fetch(", "XMLHttpRequest", "WebSocket", "import(", "sendBeacon", "<form"):
            assert bad not in text, (p.name, bad)
        refs = re.findall(r'(?:src|href)="([^"]*)"', text)
        assert refs
        for ref in refs:
            assert not re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*:|//|/)", ref), (p.name, ref)   # no scheme, no absolute path
            assert (p.parent / ref.split("#")[0]).resolve().is_file(), (p.name, ref)
    index = _index()
    assert index.count("<video") == 2 and 'type="range"' in index
    for cls in ('class="play"', 'class="prev"', 'class="next"'):
        assert index.count(cls) == 2                   # play/pause and single-frame steps for both clips
    assert index.count("<script") == 2 and "src=" not in "".join(re.findall(r"<script[^>]*>", index))


# ------------------------------------------------------------------ 6. in-demo media copies
def _episodes():
    return json.loads((v2.V2_DIR / "animation_meta.json").read_text())["episodes"]


def test_demo_media_is_in_directory_and_byte_matches_the_result_clips():
    index = _index()
    eps = _episodes()
    names = [ep["file"] for ep in eps]
    assert names == ["animation_representative.mp4", "animation_failure.mp4"]
    # each player's source is a bare file name beside index.html: no directory part, no "..", no scheme
    assert re.findall(r"<video[^>]*\ssrc=\"([^\"]*)\"", index) == names
    media = re.findall(r"<(?:video|audio|source|img|track)\b[^>]*>", index)
    assert len(media) == 2
    for tag in media:
        src = re.search(r'\ssrc="([^"]*)"', tag).group(1)
        assert re.fullmatch(r"[A-Za-z0-9_.-]+\.mp4", src) and ".." not in src, src
        assert (demo.DEMO_DIR / src).is_file() and (demo.DEMO_DIR / src).parent == demo.DEMO_DIR
    assert "results/v2/animation" not in index and "poster=" not in index
    # the copies are the result clips, byte for byte, and nothing else was packaged into demo/
    for name in names:
        a, b = (v2.V2_DIR / name).read_bytes(), (demo.DEMO_DIR / name).read_bytes()
        assert len(a) > 0 and a == b, f"demo/{name} differs from results/v2/{name}: run `make demo`"
        assert _sha(v2.V2_DIR / name) == _sha(demo.DEMO_DIR / name)
    assert sorted(p.name for p in demo.DEMO_DIR.iterdir()) == sorted(
        names + ["index.html", "report.html", "review_path.html"])


def test_copy_media_copies_repairs_and_never_writes_the_originals(tmp_path):
    src, dst = tmp_path / "v2", tmp_path / "demo"
    src.mkdir(), dst.mkdir()
    (src / "clip.mp4").write_bytes(b"\x00synthetic clip bytes\xff" * 50)
    before = ((src / "clip.mp4").read_bytes(), (src / "clip.mp4").stat().st_mtime_ns)
    eps = [{"file": "clip.mp4"}]
    assert demo.copy_media(eps, src, dst) == [("clip.mp4", _sha(src / "clip.mp4"))]
    assert (dst / "clip.mp4").read_bytes() == before[0]
    (dst / "clip.mp4").write_bytes(b"stale or truncated copy")          # a drifted copy is replaced
    demo.copy_media(eps, src, dst)
    assert (dst / "clip.mp4").read_bytes() == before[0]
    assert ((src / "clip.mp4").read_bytes(), (src / "clip.mp4").stat().st_mtime_ns) == before   # original untouched
    for bad in ("../clip.mp4", "sub/clip.mp4", "/abs/clip.mp4", "clip.mov"):   # a source may not leave demo/
        try:
            demo.media_name({"file": bad})
        except ValueError:
            continue
        raise AssertionError(bad)


def test_demo_marks_inapplicable_cells_with_a_plain_label_not_a_dash():
    index = _index()
    for dash in ("&mdash;", "&#8212;", "&#x2014;", "\u2014", "&ndash;", "\u2013"):
        assert dash not in index, dash
    row = re.search(r'<tr class="hl">(.*?)</tr>', index, re.S).group(1)
    cells = re.findall(r"<td>(.*?)</td>", row)
    assert cells[0] == "BeliefView (greedy)" and cells[4:] == ["n/a", "n/a", ""]   # compared with itself
    assert index.count("<td>n/a</td>") == 2


def test_v1_reproduction_output_is_confined_to_results_v1_repro(tmp_path, monkeypatch):
    """`tune`/`test --out` may only target results/v1_repro/ or a directory inside it. The v2 record and
    every other project directory are refused before any directory is created or any episode is run."""
    import argparse

    from beliefview import cli

    def no_run(*a, **k):
        raise AssertionError("a v1 reproduction started running although its output path must be refused")

    for name in ("tune", "run_tasks", "load_frozen", "freeze", "save_records"):
        monkeypatch.setattr(cli, name, no_run)
    before = sorted(p.name for p in v2.V2_DIR.iterdir())
    probe = "bv_refused_probe"
    refused = [v2.V2_DIR, v2.V2_DIR / probe, cli.RES, cli.RES / probe, ROOT / "archive", ARCH / probe,
               ROOT / "config", ROOT / "config" / probe, ROOT, ROOT / probe, tmp_path / probe,
               cli.RES / "v1_repro_other", cli.V1_REPRO / ".." / "v2"]
    for bad in refused:
        for cmd in (cli.cmd_test, cli.cmd_tune):
            try:
                cmd(argparse.Namespace(out=str(bad), workers=1, n=1))
            except SystemExit as e:
                assert "Refusing" in str(e)
            else:
                raise AssertionError(f"--out {bad} was accepted")
        assert bad.name not in (probe, "v1_repro_other") or not bad.exists()       # nothing was created
    try:                                               # the command line itself refuses the v2 path too
        cli.main(["test", "--out", str(v2.V2_DIR), "--n", "1"])
    except SystemExit as e:
        assert "Refusing" in str(e)
    else:
        raise AssertionError("`test --out results/v2` was accepted")
    assert sorted(p.name for p in v2.V2_DIR.iterdir()) == before          # the v2 record is untouched

    assert cli._v1_out(argparse.Namespace(out=None)) == cli.V1_REPRO.resolve()        # the default still works
    assert cli._v1_out(argparse.Namespace(out=str(cli.V1_REPRO))) == cli.V1_REPRO.resolve()
    monkeypatch.setattr(cli, "V1_REPRO", tmp_path / "v1_repro")           # a subdirectory is allowed
    sub = cli._v1_out(argparse.Namespace(out=str(tmp_path / "v1_repro" / "check")))
    assert sub == (tmp_path / "v1_repro" / "check").resolve() and sub.is_dir()
