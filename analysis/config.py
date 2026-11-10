"""Regions and model parameters for the flood forecasting pipeline.

Add a region by adding an entry to REGIONS; every script takes --region <slug>.
Each bbox must contain the whole upstream basin of the wadis that matter there,
otherwise those reaches are flagged `truncated` (risk underestimated).
"""
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = DATA / "out"

REGIONS = {
    # Najd: Wadi Hanifah from its headwaters NW of Riyadh to Al-Ha'ir, Wadi Al-Sulay (east), Wadi Nisah (SW)
    "riyadh": {
        "name_ar": "الرياض",
        "bbox": (45.80, 24.15, 47.25, 25.20),
        "utm_epsg": 32638,
        "rain_grid_deg": 0.1,
        "view": (46.70, 24.68, 9.0),
        "city_bbox": (46.48, 24.48, 46.98, 24.98),   # high-res satellite crop
        # approximate positions, for orientation labels only
        "places": [["الدرعية", 24.737, 46.575], ["العليا", 24.695, 46.685], ["البطحاء", 24.633, 46.717],
                   ["الملز", 24.665, 46.735], ["النسيم", 24.735, 46.825], ["السلي", 24.600, 46.860],
                   ["الشفا", 24.560, 46.700], ["الحائر", 24.385, 46.830], ["عرقة", 24.680, 46.585],
                   ["الملقا", 24.810, 46.610], ["مطار الملك خالد", 24.957, 46.699], ["ضاحية لبن", 24.620, 46.560]],
    },
    # Qassim: Buraydah and Unaizah on either side of Wadi Al-Rummah (basin far larger → truncated upstream)
    "qassim": {
        "name_ar": "القصيم",
        "bbox": (43.45, 25.85, 44.40, 26.65),
        "utm_epsg": 32638,
        "rain_grid_deg": 0.1,
        "view": (43.95, 26.22, 9.3),
        "city_bbox": (43.80, 25.98, 44.12, 26.45),
        # dune troughs and sabkhas: keep depressions deeper than this as closed basins
        # instead of filling them into artificial flat lakes
        "max_fill_m": 3.0,
        "places": [["بريدة", 26.330, 43.970], ["عنيزة", 26.085, 43.990], ["البكيرية", 26.140, 43.660],
                   ["مطار القصيم", 26.303, 43.774], ["الشماسية", 26.320, 44.270]],
    },
    # Hail: the city between the Aja (west) and Salma (east) ranges
    "hail": {
        "name_ar": "حائل",
        "bbox": (41.25, 26.75, 42.45, 27.85),
        "utm_epsg": 32637,
        "rain_grid_deg": 0.1,
        "view": (41.75, 27.50, 9.4),
        "city_bbox": (41.52, 27.38, 41.82, 27.64),
        "places": [["حائل", 27.520, 41.690], ["قفار", 27.430, 41.620], ["جبال أجا", 27.580, 41.380],
                   ["جبال سلمى", 27.420, 42.330], ["مطار حائل", 27.438, 41.686]],
    },
    "jeddah": {
        "name_ar": "جدة",
        "bbox": (39.05, 21.25, 39.75, 21.85),
        "utm_epsg": 32637,
        "rain_grid_deg": 0.05,
        "view": (39.33, 21.55, 9.6),
        "city_bbox": (39.10, 21.38, 39.36, 21.80),
        "places": [["البلد", 21.485, 39.187], ["قويزة", 21.445, 39.268], ["جامعة الملك عبدالعزيز", 21.495, 39.240],
                   ["المطار", 21.680, 39.160], ["أبحر", 21.755, 39.125], ["الكورنيش", 21.590, 39.108],
                   ["الحمدانية", 21.765, 39.215], ["الصواعد", 21.525, 39.290], ["وادي فاطمة", 21.370, 39.560]],
    },
}
DEFAULT_REGION = "riyadh"


def region(slug: str) -> dict:
    if slug not in REGIONS:
        raise SystemExit(f"unknown region {slug!r}; choose from {', '.join(REGIONS)}")
    return {"slug": slug, **REGIONS[slug]}


# ───────── source rasters (read remotely, only the needed window) ─────────
def dem_urls(bbox):
    """Copernicus GLO-30 COG tiles (1°) covering bbox."""
    minx, miny, maxx, maxy = bbox
    out = []
    for lat in range(math.floor(miny), math.ceil(maxy)):
        for lon in range(math.floor(minx), math.ceil(maxx)):
            ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
            name = f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"
            out.append(f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif")
    return out


def worldcover_urls(bbox):
    """ESA WorldCover 2021 v200 COG tiles (3°) covering bbox."""
    minx, miny, maxx, maxy = bbox
    out = []
    for lat in range(math.floor(miny / 3) * 3, math.ceil(maxy / 3) * 3, 3):
        for lon in range(math.floor(minx / 3) * 3, math.ceil(maxx / 3) * 3, 3):
            ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
            out.append("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
                       f"ESA_WorldCover_10m_2021_v200_{ns}{abs(lat):02d}{ew}{abs(lon):03d}_Map.tif")
    return out


# GDAL remote-read settings (honours HTTPS_PROXY; CA bundle for proxied environments)
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "2",
    "VSI_CACHE": "TRUE",
}
if os.path.exists("/root/.ccr/ca-bundle.crt") and "CURL_CA_BUNDLE" not in os.environ:
    GDAL_ENV["CURL_CA_BUNDLE"] = "/root/.ccr/ca-bundle.crt"

# ───────── hydrology parameters ─────────
CELL_M = 30                       # analysis resolution (Copernicus GLO-30)
STREAM_MIN_AREA_KM2 = 1.0         # a channel starts where ≥ 1 km² drains to a cell
HAND_ZONE_M = 3.0                 # cells ≤ 3 m above their channel = flood-prone
ZONE_MIN_UPSTREAM_KM2 = 5.0       # only draw flood zones along channels with ≥ 5 km² upstream
SEA_LEVEL_M = 0.5                 # DEM cells at/below this that are water → sea (outlet)

# ───────── SCS curve numbers per ESA WorldCover class ─────────
# Arid-region values (hydrologic soil group B/C on alluvium, D on rock).
# Bare/sparse (60) is split by slope: steep = exposed rock, flat = sandy wadi fill.
CN_BY_CLASS = {
    10: 70,   # tree cover (mostly palm groves in these regions)
    20: 80,   # shrubland (sparse arid shrub)
    30: 79,   # grassland
    40: 78,   # cropland (irrigated farms)
    50: 92,   # built-up (roofs, asphalt)
    60: None, # bare/sparse → slope rule below
    70: 98, 80: 98, 90: 85, 95: 85, 100: 80,
}
CN_BARE_ROCK = 91       # slope ≥ BARE_ROCK_SLOPE
CN_BARE_SAND = 74       # slope <  BARE_ROCK_SLOPE
BARE_ROCK_SLOPE = 0.10  # 10 %
BUILT_UP_CLASS = 50


# The active region. Scripts call use_region() early (reads --region or FLOOD_REGION).
REGION = region(os.environ.get("FLOOD_REGION", DEFAULT_REGION))


def use_region(argv=None) -> dict:
    """Pick the region from `--region <slug>` in argv (removed from argv) or FLOOD_REGION."""
    global REGION
    import sys
    argv = sys.argv if argv is None else argv
    if "--region" in argv:
        i = argv.index("--region")
        REGION = region(argv[i + 1])
        del argv[i:i + 2]
    return REGION
