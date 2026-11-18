"""Cache-integrity tests for belief_ml.data.generate (no simulator needed: a fake generator stands in for `npx tsx`).
Run: python -m unittest discover -s demo3d/ml/tests   (from the repo root, with demo3d/ml on sys.path via the first line below)."""
import gzip, json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from belief_ml import data  # noqa: E402


def make_demo(d):
    for rel in ("src/sim/a.ts", "src/ml/features.ts", "src/ml/episodes.ts", "src/ml/replay.ts", "src/ml/scenarios.ts", "tools/gen_episodes.ts", "ml/belief_ml/__init__.py", "ml/belief_ml/episodes_cfg.py"):
        p = os.path.join(d, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f: f.write("x")


class FakeGen:
    def __init__(self, n_override=None, drop=0): self.calls = 0; self.n_override = n_override; self.drop = drop

    def __call__(self, cmd, cwd, check):
        self.calls += 1
        count = int(cmd[cmd.index("--count") + 1]); out = cmd[cmd.index("--out") + 1]
        with gzip.open(out, "wt") as f:
            for k in range(self.n_override or count - self.drop):
                f.write(json.dumps({"ep": f"{cmd[cmd.index('--split') + 1]}-{k}"}) + "\n")


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.d = self.t.name; make_demo(self.d)
        self.out = os.path.join(self.d, "ml", "data", "x", "train.jsonl.gz"); self.g = FakeGen(); self.log = lambda *_: None

    def tearDown(self): self.t.cleanup()

    def gen(self, count=5, split="train", g=None): return data.generate(self.d, split, count, self.out, run=g or self.g, log=self.log)

    def test_hit_then_regenerate_on_each_kind_of_staleness(self):
        self.assertEqual(self.gen(), "generated"); self.assertEqual(self.gen(), "cached"); self.assertEqual(self.g.calls, 1)
        self.assertEqual(self.gen(count=7), "generated", "episode count change must invalidate")
        self.assertEqual(self.gen(count=7), "cached")
        self.assertEqual(self.gen(count=7, split="val"), "generated", "split/seed change must invalidate")
        with open(os.path.join(self.d, "src/sim/a.ts"), "w") as f: f.write("changed")
        self.assertEqual(self.gen(count=7, split="val"), "generated", "simulator source change must invalidate")
        self.assertEqual(self.gen(count=7, split="val"), "cached")
        with gzip.open(self.out, "wt") as f: f.write(json.dumps({"ep": "tampered"}) + "\n")
        self.assertEqual(self.gen(count=7, split="val"), "generated", "content tampering must invalidate")

    def test_data_without_metadata_is_never_trusted(self):
        os.makedirs(os.path.dirname(self.out))
        with gzip.open(self.out, "wt") as f: f.write(json.dumps({"ep": "old"}) + "\n")
        self.assertEqual(self.gen(), "generated")
        with gzip.open(self.out, "rt") as f: self.assertEqual(len(f.readlines()), 5)

    def test_episode_without_samples_is_allowed_but_not_many(self):
        g = FakeGen(drop=1)
        self.assertEqual(data.generate(self.d, "train", 20, self.out, run=g, log=self.log), "generated")
        with self.assertRaises(RuntimeError): data.generate(self.d, "val", 20, self.out + "2", run=FakeGen(drop=5), log=self.log)

    def test_wrong_episode_count_is_rejected_and_nothing_is_left_behind(self):
        with self.assertRaises(RuntimeError): self.gen(g=FakeGen(n_override=3))  # 3 of 5 < 90%
        self.assertFalse(os.path.exists(self.out)); self.assertFalse(os.path.exists(self.out + ".meta.json"))
        self.assertFalse(os.path.exists(self.out + ".tmp"))


if __name__ == "__main__":
    unittest.main()
