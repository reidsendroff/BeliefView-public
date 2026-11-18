import base64, gzip, hashlib, json, os, subprocess
import numpy as np
from . import EXTRACTOR_VERSION, GRID_N, N_CHANNELS, N_SCALARS
from .episodes_cfg import SPLIT_SEEDS
from .provenance import source_hashes

META_SCHEMA = 1


def file_sha256(path):
    h = hashlib.sha256()
    with gzip.open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def expected_meta(demo3d_dir, split, count, first):
    """What a valid cached dataset must have been generated with. Any difference (count, split/seeds, extractor, simulator source) invalidates it."""
    w0, s0 = SPLIT_SEEDS[split]
    return {"metaSchema": META_SCHEMA, "split": split, "first": first, "count": count, "world0": w0, "subject0": s0,
            "extractorVersion": EXTRACTOR_VERSION, "sourceSha256": source_hashes(demo3d_dir)["combined"]}


def meta_path(out_path):
    return out_path + ".meta.json"


def cache_status(demo3d_dir, split, count, out_path, first=0):
    """Returns (ok, reason). Valid only if the data file AND its metadata exist, metadata equals the expected one, the content hash matches, and the episode count is right."""
    if not os.path.exists(out_path):
        return False, "no data file"
    if not os.path.exists(meta_path(out_path)):
        return False, "no metadata (unverifiable cache)"
    try:
        meta = json.load(open(meta_path(out_path)))
    except Exception as e:  # noqa: BLE001
        return False, f"unreadable metadata: {e}"
    exp = expected_meta(demo3d_dir, split, count, first)
    for k, v in exp.items():
        if meta.get(k) != v:
            return False, f"metadata mismatch on {k}: cached {meta.get(k)!r} != expected {v!r}"
    try:
        if file_sha256(out_path) != meta.get("contentSha256"):
            return False, "content hash does not match metadata"
    except Exception as e:  # noqa: BLE001
        return False, f"unreadable data file: {e}"
    return True, "valid"


def _episodes(path):
    eps = set()
    for line in gzip.open(path, "rt"):
        eps.add(json.loads(line)["ep"])
    return eps


def _check_episodes(path, split, count, first):
    """Episodes with no lost-fix tick legitimately produce no samples, so the exact number with samples can be < count.
    Require: every episode id lies in the requested range and at least 90% of the requested episodes have samples."""
    eps = _episodes(path)
    want = {f"{split}-{k}" for k in range(first, first + count)}
    stray = eps - want
    if stray or len(eps) < 0.9 * count:
        raise RuntimeError(f"generator output does not match the request for {split}: {len(eps)} episodes with samples (>= {int(0.9 * count)} expected), {len(stray)} outside the requested range")
    return len(eps)


def generate(demo3d_dir, split, count, out_path, first=0, run=subprocess.run, log=print):
    """Run the TypeScript generator (the real simulator) unless a VALID cache exists. Generation is atomic (temp file + rename).
    Returns "cached" or "generated"."""
    ok, why = cache_status(demo3d_dir, split, count, out_path, first)
    if ok:
        log(f"  cache hit for {split} ({count} episodes): metadata, source hash and content hash verified")
        return "cached"
    log(f"  regenerating {split} ({count} episodes): {why}")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    for p in (tmp, meta_path(out_path)):
        if os.path.exists(p):
            os.remove(p)
    run(["npx", "tsx", "tools/gen_episodes.ts", "--split", split, "--count", str(count), "--first", str(first), "--out", tmp], cwd=demo3d_dir, check=True)
    try:
        n_eps = _check_episodes(tmp, split, count, first)
    except RuntimeError:
        os.remove(tmp)
        raise
    meta = dict(expected_meta(demo3d_dir, split, count, first), contentSha256=file_sha256(tmp), episodesWithSamples=n_eps)
    mtmp = meta_path(out_path) + ".tmp"
    with open(mtmp, "w") as f:
        json.dump(meta, f, indent=1); f.write("\n")
    os.replace(tmp, out_path)       # data first, then metadata: a crash between them leaves "no metadata" => regenerated next time
    os.replace(mtmp, meta_path(out_path))
    return "generated"


def load(path):
    recs = [json.loads(l) for l in gzip.open(path, "rt")]
    n = len(recs)
    codes = np.empty((n, N_CHANNELS, GRID_N, GRID_N), np.uint8)
    for k, r in enumerate(recs):
        codes[k] = np.frombuffer(base64.b64decode(r["g"]), np.uint8).reshape(N_CHANNELS, GRID_N, GRID_N)
    d = {
        "codes": codes,
        "scalars": np.array([r["sc"] for r in recs], np.float32).reshape(n, N_SCALARS),
        "yc": np.array([r["yc"] if r["yc"] else [-1, -1] for r in recs], np.int64),
        "y": np.array([r["y"] for r in recs], np.float64),
        "center": np.array([r["c"] for r in recs], np.float64),
        "kal": np.array([[k[0], k[1], k[2], float(k[3])] for k in (r["kal"] for r in recs)], np.float64),
        "elapsed": np.array([r["el"] for r in recs], np.float64),
        "ep": np.array([r["ep"] for r in recs]),
        "w": np.array([r["w"] for r in recs]), "s": np.array([r["s"] for r in recs]),
        "i": np.array([r["i"] for r in recs]),
        "tags": {k: np.array([r["tags"][k] for r in recs], bool) for k in ("hide", "turn", "long", "reacq")},
    }
    d["inside"] = d["yc"][:, 0] >= 0
    d["target"] = np.where(d["inside"], d["yc"][:, 0] * GRID_N + d["yc"][:, 1], -1)
    return d


def cell_centres(center):
    """[N, 1024, 2] world xz of every cell for each sample (matches cellCentre() in features.ts)."""
    j = (np.arange(GRID_N) + 0.5 - GRID_N / 2) * 4
    gx, gz = np.meshgrid(j, j)  # gz varies along rows
    off = np.stack([gx.ravel(), gz.ravel()], -1)
    return center[:, None, :] + off[None]
