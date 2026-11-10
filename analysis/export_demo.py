"""Export a compact, self-contained dataset for the browser demo (no server needed).

    DATABASE_URL=… python analysis/export_demo.py out.json

Contains: channels (≥ 3 km² upstream) with model parameters and rain-point weights,
flood-prone zones with buildings, built-up footprint, hillshade image (Web Mercator PNG),
rain points, and the newest live forecast's hourly rain.
"""
import base64
import io
import json
import math
import sys

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_bounds
from rasterio.features import shapes
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
import shapely

import config as C
from db import connect

MIN_UP_KM2 = 3


def r5(geojson, nd=4):
    """Round coordinates to shrink the payload (4 decimals ≈ 11 m)."""
    def rnd(c):
        return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [rnd(x) for x in c]
    return {"type": geojson["type"], "coordinates": rnd(geojson["coordinates"])}


def hillshade_and_builtup():
    minx, miny, maxx, maxy = C.REGION["bbox"]
    mx0, my0, mx1, my1 = transform_bounds("EPSG:4326", "EPSG:3857", minx, miny, maxx, maxy)
    W = 1400
    H = int(W * (my1 - my0) / (mx1 - mx0))
    tr = from_bounds(mx0, my0, mx1, my1, W, H)
    dem = np.full((H, W), np.nan, dtype="float32")
    with rasterio.open(next(C.RAW.glob("dem_*.tif"))) as src:
        reproject(rasterio.band(src, 1), dem, dst_transform=tr, dst_crs="EPSG:3857", resampling=Resampling.bilinear)
    lc = np.zeros((H, W), dtype="uint8")
    with rasterio.open(next(C.RAW.glob("wc_*.tif"))) as src:
        reproject(rasterio.band(src, 1), lc, dst_transform=tr, dst_crs="EPSG:3857", resampling=Resampling.mode)

    # hillshade (sun from the north-west), metres per pixel corrected for Mercator scale
    cell = (mx1 - mx0) / W * math.cos(math.radians((miny + maxy) / 2))
    dy, dx = np.gradient(dem, cell)
    slope = np.arctan(np.hypot(dx, dy) * 1.6)
    aspect = np.arctan2(-dx, dy)
    az, alt = math.radians(315), math.radians(45)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    hs = np.clip(hs, 0, 1)
    sea = (dem <= 0.5) & ((lc == 80) | (lc == 0))
    # grayscale shading as alpha so the page can tint it per theme: dark where shaded
    alpha = ((1 - hs) * 200).astype("uint8")
    alpha[sea] = 0
    rgba = np.zeros((H, W, 4), dtype="uint8")
    rgba[..., 3] = alpha
    import matplotlib.image as mpimg
    buf = io.BytesIO()
    mpimg.imsave(buf, rgba, format="png")
    hill = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    # sea and built-up footprints as simplified polygons
    def polys(mask, tol):
        geoms = [shape(g) for g, v in shapes(mask.astype("uint8"), mask=mask, transform=tr) if v == 1]
        u = unary_union(geoms).simplify(tol)
        from pyproj import Transformer
        t = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
        u = shapely.transform(u, lambda xy: np.column_stack(t.transform(xy[:, 0], xy[:, 1])))
        return r5(mapping(u))
    built = (lc == 50)
    return hill, [[miny, minx], [maxy, maxx]], polys(sea, 60), polys(built, 45)


def main(path):
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM public.regions WHERE slug = %s", (C.REGION["slug"],))
        region_id = cur.fetchone()[0]
        cur.execute("""SELECT id, ST_X(geom), ST_Y(geom) FROM public.rain_points WHERE region_id = %s ORDER BY id""", (region_id,))
        rps = cur.fetchall()
        pidx = {p[0]: i for i, p in enumerate(rps)}
        cur.execute("""SELECT s.id, ST_AsGeoJSON(ST_SimplifyPreserveTopology(s.geom, 0.00015))::json, s.upstream_km2, s.tc_h,
                              s.cn_up, s.zone_built_km2, s.truncated, s.downstream_id
                       FROM public.streams s WHERE s.region_id = %s AND s.upstream_km2 >= %s ORDER BY s.upstream_km2""",
                    (region_id, MIN_UP_KM2))
        streams = cur.fetchall()
        keep = {s[0] for s in streams}
        cur.execute("""SELECT w.stream_id, w.rain_point_id, w.area_km2 FROM public.stream_rain_weights w
                       JOIN public.streams s ON s.id = w.stream_id
                       WHERE s.region_id = %s AND s.upstream_km2 >= %s""", (region_id, MIN_UP_KM2))
        weights = {}
        for sid, pid, a in cur.fetchall():
            weights.setdefault(sid, []).append([pidx[pid], round(float(a), 3)])
        cur.execute("""SELECT z.stream_id, ST_AsGeoJSON(ST_SimplifyPreserveTopology(z.geom, 0.0002))::json, z.built_up_km2
                       FROM public.flood_zones z JOIN public.streams s ON s.id = z.stream_id
                       WHERE s.region_id = %s AND z.built_up_km2 >= 0.01 AND s.upstream_km2 >= %s""", (region_id, MIN_UP_KM2))
        zones = [{"s": z[0], "g": r5(z[1]), "b": round(float(z[2]), 3)} for z in cur.fetchall()]

        cur.execute("""SELECT id, start_time, created_at, params FROM public.forecast_runs
                       WHERE region_id = %s AND kind = 'forecast' ORDER BY created_at DESC LIMIT 1""", (region_id,))
        live = cur.fetchone()
        live_out = None
        if live:
            cur.execute("""SELECT rain_point_id, valid_time, precip_mm FROM public.forecast_rain WHERE run_id = %s""", (live[0],))
            rows = cur.fetchall()
            # history hours with zero rain are not stored → rebuild the full hourly axis
            from datetime import timedelta
            hist = int(live[3].get("history_h", 0))
            t_first = live[1] - timedelta(hours=hist)
            t_last = max(r[1] for r in rows)
            n = int((t_last - t_first).total_seconds() // 3600) + 1
            times = [t_first + timedelta(hours=i) for i in range(n)]
            tix = {t: i for i, t in enumerate(times)}
            R = np.zeros((len(rps), n))
            for pid, t, mm in rows:
                if t in tix:
                    R[pidx[pid], tix[t]] = mm
            start_i = max(0, hist - 120)
            live_out = {"issued": live[2].isoformat(), "start": live[1].isoformat(),
                        "t0": times[start_i].isoformat(), "history_h": hist - start_i,
                        "rain": [[round(v, 1) for v in row[start_i:]] for row in R]}

    hill, hill_bounds, sea, built = hillshade_and_builtup()
    data = {
        "region": {"name_ar": C.REGION["name_ar"], "bbox": C.REGION["bbox"]},
        "rain_points": [[round(p[1], 3), round(p[2], 3)] for p in rps],
        "streams": [{"id": s[0], "g": r5(s[1]), "a": round(float(s[2]), 2), "tc": float(s[3]), "cn": float(s[4]),
                     "b": round(float(s[5]), 3), "t": bool(s[6]), "d": s[7] if s[7] in keep else None,
                     "w": weights.get(s[0], [])} for s in streams],
        "zones": zones, "sea": sea, "built": built,
        "hillshade": {"url": hill, "bounds": hill_bounds},
        "live": live_out,
    }
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size = sum(len(json.dumps(data[k], separators=(",", ":"))) for k in data) / 1e6
    print(f"streams {len(streams)}, zones {len(zones)}, live={'yes' if live_out else 'no'} → {path} ({size:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo_data.json")
