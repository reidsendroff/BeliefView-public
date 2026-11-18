"""BeliefView 3D learned search-belief pipeline (synthetic simulator data only)."""
GRID_N = 32
CELL_M = 4
N_CHANNELS = 8
N_SCALARS = 13
EXTRACTOR_VERSION = 2
CHANNELS = [
    "canopy_cover", "trunk_proximity", "sensor_visible_now", "sensor_visible_memory",
    "extrapolated_position", "reachable_radius", "drone_position", "terrain_height",
]
SCALARS = [
    "elapsed_since_fix", "time", "last_fix_sigma", "est_vx", "est_vz", "est_speed", "drone_agl",
    "cam_yaw_sin", "cam_yaw_cos", "cam_pitch", "drone_dx_from_center", "drone_dz_from_center",
    "recent_fix_count",
]
# Mirrors SCALAR_NORM in src/ml/features.ts (a test compares the shipped manifest with the TypeScript constants).
SCALAR_NORM = {
    "elapsed_since_fix": (30, 0, 2), "time": (75, 0, 2), "last_fix_sigma": (2, 0, 2),
    "est_vx": (6, -1.5, 1.5), "est_vz": (6, -1.5, 1.5), "est_speed": (6, 0, 1.5), "drone_agl": (30, -1, 2),
    "cam_yaw_sin": (1, -1, 1), "cam_yaw_cos": (1, -1, 1), "cam_pitch": (1.5, -1.5, 1.5),
    "drone_dx_from_center": (64, -3, 3), "drone_dz_from_center": (64, -3, 3),
    "recent_fix_count": (20, 0, 2),
}
