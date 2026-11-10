"""Region and model parameters for the flood forecasting pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = DATA / "raw"
OUT = DATA / "out"

# ───────── pilot region: Jeddah and the eastern wadis that drain into it ─────────
REGION = {
    "slug": "jeddah",
    "name_ar": "جدة",
    "bbox": (39.05, 21.25, 39.75, 21.85),   # minLng, minLat, maxLng, maxLat
    "utm_epsg": 32637,                        # UTM 37N
}

CELL_M = 30                       # analysis resolution (Copernicus GLO-30)
STREAM_MIN_AREA_KM2 = 1.0         # a channel starts where ≥ 1 km² drains to a cell
HAND_ZONE_M = 3.0                 # cells ≤ 3 m above their channel = flood-prone
ZONE_MIN_UPSTREAM_KM2 = 5.0       # only draw flood zones along channels with ≥ 5 km² upstream
RAIN_GRID_DEG = 0.05              # weather lookup grid (~5 km; NWP models are 2–11 km)
SEA_LEVEL_M = 0.5                 # DEM cells at/below this that are water → sea (outlet)

# ───────── SCS curve numbers per ESA WorldCover class ─────────
# Arid-region values (hydrologic soil group B/C on alluvium, D on rock).
# Bare/sparse (60) is split by slope: steep = exposed rock, flat = sandy wadi fill.
CN_BY_CLASS = {
    10: 70,   # tree cover
    20: 80,   # shrubland (sparse arid shrub)
    30: 79,   # grassland
    40: 78,   # cropland
    50: 92,   # built-up (roofs, asphalt)
    60: None, # bare/sparse → slope rule below
    70: 98, 80: 98, 90: 85, 95: 85, 100: 80,
}
CN_BARE_ROCK = 91       # slope ≥ BARE_ROCK_SLOPE
CN_BARE_SAND = 74       # slope <  BARE_ROCK_SLOPE
BARE_ROCK_SLOPE = 0.10  # 10 %
BUILT_UP_CLASS = 50
