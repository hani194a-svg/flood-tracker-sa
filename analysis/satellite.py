"""Cloud-free Sentinel-2 true-colour background images for the browser demo.

    python analysis/satellite.py --region riyadh      # → demo/data/sat/riyadh.json + 2 JPEGs

For each region it writes two Web-Mercator JPEGs (so a Leaflet imageOverlay lines up exactly):
  - overview: the whole region (~30–40 m per pixel)
  - city:     the urban area at up to ~10 m per pixel (Sentinel-2 native resolution)

Source: Sentinel-2 L2A "visual" (TCI) COGs on AWS, found via the Earth Search STAC API.
For each 100 km MGRS tile the least cloudy recent scene is used.
Attribution: "Contains modified Copernicus Sentinel data <year>".
"""
from __future__ import annotations

import json
import math
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling, transform_bounds

import config as C

STAC = "https://earth-search.aws.element84.com/v1/search"
OUT = Path(__file__).resolve().parents[1] / "demo" / "data" / "sat"


def search_scenes(bbox, days=120, max_cloud=30, per_tile=3, max_pages=8):
    """Up to `per_tile` clearest recent scenes per MGRS tile. Several per tile are kept
    because a scene at the edge of the satellite's swath covers only part of its tile."""
    end = datetime.now(timezone.utc)
    body = {
        "collections": ["sentinel-2-l2a"], "bbox": list(bbox), "limit": 100,
        "datetime": f"{(end - timedelta(days=days)).strftime('%Y-%m-%dT00:00:00Z')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
        "fields": {"include": ["id", "properties.datetime", "properties.eo:cloud_cover", "properties.grid:code",
                               "assets.visual.href"]},
    }
    feats = []
    for _ in range(max_pages):
        req = urllib.request.Request(STAC, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            page = json.loads(r.read())
        feats += page["features"]
        nxt = next((l for l in page.get("links", []) if l.get("rel") == "next"), None)
        if not nxt or not page["features"]:
            break
        body = nxt.get("body") or body
    by_tile = {}
    for f in feats:   # newest first; sort is stable, so ties in cloud cover keep the newest
        by_tile.setdefault(f["properties"].get("grid:code") or f["id"].split("_")[1], []).append(f)
    return [f for fs in by_tile.values() for f in sorted(fs, key=lambda f: f["properties"]["eo:cloud_cover"])[:per_tile]]


def render(scenes, bbox, max_px, min_m_per_px=10.0):
    """Mosaic TCI scenes onto a Web-Mercator grid covering bbox; returns (rgb, latlon bounds)."""
    mx0, my0, mx1, my1 = transform_bounds("EPSG:4326", "EPSG:3857", *bbox)
    lat_scale = math.cos(math.radians((bbox[1] + bbox[3]) / 2))     # mercator metres → ground metres
    ground_w = (mx1 - mx0) * lat_scale
    W = int(min(max_px, ground_w / min_m_per_px))
    H = int(W * (my1 - my0) / (mx1 - mx0))
    tr = from_bounds(mx0, my0, mx1, my1, W, H)
    rgb = np.zeros((3, H, W), dtype=np.uint8)
    filled = np.zeros((H, W), bool)
    with rasterio.Env(**C.GDAL_ENV):
        for f in sorted(scenes, key=lambda f: f["properties"]["eo:cloud_cover"]):
            with rasterio.open("/vsicurl/" + f["assets"]["visual"]["href"]) as src, \
                 WarpedVRT(src, crs="EPSG:3857", transform=tr, width=W, height=H,
                           resampling=Resampling.average, nodata=0) as vrt:
                arr = vrt.read()
            have = arr.any(axis=0) & ~filled
            rgb[:, have] = arr[:, have]
            filled |= have
    return rgb, [[bbox[1], bbox[0]], [bbox[3], bbox[2]]], round(ground_w / W, 1), float(filled.mean())


def save_jpeg(rgb, path, quality=78):
    from PIL import Image, ImageEnhance
    img = Image.fromarray(np.moveaxis(rgb, 0, -1))
    img = ImageEnhance.Contrast(img).enhance(1.12)     # TCI is a little flat over bright desert
    img.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    return path.stat().st_size


def main():
    reg = C.REGION
    OUT.mkdir(parents=True, exist_ok=True)
    scenes = search_scenes(reg["bbox"])
    if not scenes:
        raise SystemExit("no cloud-free scenes found")
    dates = sorted(f["properties"]["datetime"][:10] for f in scenes)
    print(f"{reg['slug']}: {len(scenes)} scenes, {dates[0]} … {dates[-1]}")

    meta = {"attribution": f"Contains modified Copernicus Sentinel data {dates[-1][:4]}",
            "dates": [dates[0], dates[-1]], "layers": []}
    for name, bbox, max_px in [("overview", reg["bbox"], 4200), ("city", reg.get("city_bbox"), 4800)]:
        if not bbox:
            continue
        rgb, bounds, mpp, cover = render(scenes, bbox, max_px)
        fn = f"{reg['slug']}-{name}.jpg"
        size = save_jpeg(rgb, OUT / fn)
        meta["layers"].append({"name": name, "file": f"sat/{fn}", "bounds": bounds, "m_per_px": mpp})
        print(f"  {name}: {rgb.shape[2]}×{rgb.shape[1]} px, {mpp} m/px, {cover:.0%} covered, {size / 1e6:.1f} MB")
    (OUT / f"{reg['slug']}.json").write_text(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    C.use_region()
    main()
