# Mirrors SPLITS in src/ml/episodes.ts (world0, subject0). `test` is a DEVELOPMENT split (looked at while tuning); `audit` is the fresh final-audit split.
SPLIT_SEEDS = {"train": (1000, 5000), "val": (20000, 25000), "test": (40000, 45000), "audit": (60000, 65000)}

_BASE = dict(seed=20260101, channels=32, dilations=[1, 2, 4, 8, 1, 2], scalar_embed=16, lr=1e-3, batch=128, weight_decay=2e-2, dropout=0.15, patience=4, version="2.0.0")
PROFILES = {
    # seconds-long wiring check (used by tests / CI-style smoke runs; its weights are NOT shipped)
    "smoke": dict(_BASE, epochs=2, episodes={"train": 6, "val": 3, "test": 3, "audit": 3}, model_id="beliefview3d-search-smoke"),
    # what was run locally on CPU to produce the committed weights
    "local": dict(_BASE, epochs=16, episodes={"train": 900, "val": 60, "test": 100, "audit": 100}, model_id="beliefview3d-search-v1"),
    # suggested Colab GPU/CPU profile: more episodes, longer training
    "colab": dict(_BASE, epochs=30, episodes={"train": 1200, "val": 150, "test": 200, "audit": 100}, model_id="beliefview3d-search-v1"),
}
