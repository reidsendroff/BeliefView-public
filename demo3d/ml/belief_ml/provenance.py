"""Exact-content provenance: SHA-256 of every source file that determines the training data / features, plus the feature schema.

`git rev-parse HEAD` alone is not enough (the working tree may be dirty or uncommitted), so the manifest records these hashes too.
The list below is the single source of truth; the manifest stores the per-file hashes so a test can re-verify them without this list.
"""
import glob, hashlib, json, os
from . import CELL_M, CHANNELS, EXTRACTOR_VERSION, GRID_N, SCALARS, SCALAR_NORM

# Relative to demo3d/. Simulator + feature extractor + generation/config + Python feature/split mirrors.
SOURCE_GLOBS = [
    "src/sim/*.ts",
    "src/ml/features.ts", "src/ml/episodes.ts", "src/ml/replay.ts", "src/ml/scenarios.ts",
    "tools/gen_episodes.ts",
    "ml/belief_ml/__init__.py", "ml/belief_ml/episodes_cfg.py",
]


def _sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def source_hashes(demo3d_dir):
    files = sorted({os.path.relpath(p, demo3d_dir).replace(os.sep, "/") for g in SOURCE_GLOBS for p in glob.glob(os.path.join(demo3d_dir, g))})
    per = {rel: _sha(os.path.join(demo3d_dir, rel)) for rel in files}
    combined = hashlib.sha256("".join(f"{k}\0{v}\n" for k, v in per.items()).encode()).hexdigest()
    return {"combined": combined, "files": per}


def feature_schema_sha256():
    """Canonical JSON (sorted keys, no spaces) of the feature contract. The TypeScript test builds the identical string from src/ml/features.ts."""
    schema = {
        "cellMeters": CELL_M, "channels": list(CHANNELS), "extractorVersion": EXTRACTOR_VERSION, "gridN": GRID_N,
        "scalars": [{"max": SCALAR_NORM[n][2], "min": SCALAR_NORM[n][1], "name": n, "scale": SCALAR_NORM[n][0]} for n in SCALARS],
    }
    return hashlib.sha256(json.dumps(schema, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
