"""Terrain preprocessing: DEM + land cover → channels, catchments, flood-prone zones.

Run once per region (or when source data changes):
    python analysis/terrain.py

Inputs (analysis/data/raw):
    dem_*.tif   Copernicus GLO-30 DEM tile(s)
    wc_*.tif    ESA WorldCover 2021 tile(s)
Outputs (analysis/data/out/<region>):
    streams.geojson, catchments.geojson, flood_zones.geojson, rain_points.json,
    upstream_weights.json, meta.json, preview.png
"""
from __future__ import annotations

import json
import math
import time
from collections import defaultdict

import numpy as np

# pysheds 0.5 still calls np.in1d, removed in NumPy 2
if not hasattr(np, "in1d"):
    np.in1d = lambda a, b, **kw: np.isin(np.ravel(a), b, **kw)
import rasterio
from rasterio.features import shapes
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling, transform_bounds, transform as warp_xy
from shapely.geometry import shape, mapping, LineString
import shapely
from shapely.ops import unary_union
from pyproj import Transformer
from pysheds.grid import Grid
from pysheds.view import Raster, ViewFinder

import config as C

# D8 encoding used by pysheds: N, NE, E, SE, S, SW, W, NW
DIRMAP = (64, 128, 1, 2, 4, 8, 16, 32)
OFFSETS = {64: (-1, 0), 128: (-1, 1), 1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1)}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ───────────────────────── 1. grids ─────────────────────────
def target_grid():
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", f"EPSG:{C.REGION['utm_epsg']}", *C.REGION["bbox"])
    width = int(math.ceil((maxx - minx) / C.CELL_M))
    height = int(math.ceil((maxy - miny) / C.CELL_M))
    return from_origin(minx, maxy, C.CELL_M, C.CELL_M), width, height


def warp(paths, dst_transform, w, h, resampling, dtype, nodata):
    srcs = [rasterio.open(p) for p in paths]
    arr, tr = merge(srcs) if len(srcs) > 1 else (srcs[0].read(), srcs[0].transform)
    out = np.full((h, w), nodata, dtype=dtype)
    reproject(arr[0], out, src_transform=tr, src_crs=srcs[0].crs, src_nodata=srcs[0].nodata,
              dst_transform=dst_transform, dst_crs=f"EPSG:{C.REGION['utm_epsg']}", dst_nodata=nodata,
              resampling=resampling)
    for s in srcs:
        s.close()
    return out


# ───────────────────────── 2. hydrology ─────────────────────────
def downstream_index(fdir: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Flat index of each cell's D8 receiver; self for outlets / nodata / off-grid."""
    h, w = fdir.shape
    rows, cols = np.indices((h, w))
    nr, nc = rows.copy(), cols.copy()
    for code, (dr, dc) in OFFSETS.items():
        m = fdir == code
        nr[m] += dr
        nc[m] += dc
    inside = (nr >= 0) & (nr < h) & (nc >= 0) & (nc < w)
    nr = np.where(inside, nr, rows)
    nc = np.where(inside, nc, cols)
    idx = (nr * w + nc).ravel()
    self_idx = np.arange(h * w)
    ok = valid.ravel() & valid.ravel()[idx]
    return np.where(ok, idx, self_idx)


def jump_fill(labels: np.ndarray, pointer: np.ndarray, unknown=-1) -> np.ndarray:
    """Pointer jumping: each unknown cell takes the label found by following `pointer`."""
    lab, ptr = labels.copy(), pointer.copy()
    for _ in range(64):
        need = lab == unknown
        if not need.any():
            break
        lab = np.where(need, lab[ptr], lab)
        nxt = ptr[ptr]
        if np.array_equal(nxt, ptr):
            lab = np.where(lab == unknown, lab[ptr], lab)
            break
        ptr = nxt
    return lab


def segment_streams(stream: np.ndarray, down: np.ndarray):
    """Split the channel network into reaches between heads/confluences.

    Returns seg (flat int array, -1 off-channel), reach start cells, and ordered cell lists.
    """
    n = stream.size
    s = stream.ravel()
    # count upstream channel neighbours of every channel cell
    src = np.flatnonzero(s & (down != np.arange(n)))
    src = src[s[down[src]]]
    up_count = np.bincount(down[src], minlength=n)
    single_up = np.full(n, -1, dtype=np.int64)
    one = up_count[down[src]] == 1
    single_up[down[src][one]] = src[one]

    starts = np.flatnonzero(s & (up_count != 1))           # heads (0) and confluences (≥2)
    seg = np.full(n, -1, dtype=np.int64)
    seg[starts] = np.arange(len(starts))
    ptr = np.where(single_up >= 0, single_up, np.arange(n))  # walk upstream
    seg = np.where(s, jump_fill(np.where(s, seg, -2), ptr, unknown=-1), -1)
    seg[~s] = -1

    # order cells inside each reach by following `down` from its start
    cells = []
    for k, st in enumerate(starts):
        path, cur = [st], st
        while True:
            nxt = down[cur]
            if nxt == cur or seg[nxt] != k:
                break
            path.append(nxt)
            cur = nxt
        cells.append(np.array(path))
    return seg, starts, cells


def main():
    out = C.OUT / C.REGION["slug"]
    out.mkdir(parents=True, exist_ok=True)
    epsg = C.REGION["utm_epsg"]
    tr, w, h = target_grid()
    cell_km2 = (C.CELL_M / 1000) ** 2
    log(f"grid {w}×{h} @ {C.CELL_M} m, EPSG:{epsg}")

    dem = warp(sorted(C.RAW.glob("dem_*.tif")), tr, w, h, Resampling.bilinear, "float32", -9999)
    lc = warp(sorted(C.RAW.glob("wc_*.tif")), tr, w, h, Resampling.mode, "uint8", 0)
    sea = ((dem <= C.SEA_LEVEL_M) & ((lc == 80) | (lc == 0))) | (dem == -9999)
    dem[sea] = -9999
    valid = ~sea
    log(f"sea/nodata cells: {sea.mean():.1%}")

    # pysheds works on its own Raster type tied to a ViewFinder
    vf = ViewFinder(affine=tr, shape=dem.shape, crs=f"EPSG:{epsg}", nodata=-9999)
    grid = Grid(viewfinder=vf)
    rdem = Raster(dem, viewfinder=vf)
    log("conditioning DEM (pits, depressions, flats)…")
    cond = grid.resolve_flats(grid.fill_depressions(grid.fill_pits(rdem)))
    fdir = grid.flowdir(cond, dirmap=DIRMAP, nodata_out=0)
    acc = grid.accumulation(fdir, dirmap=DIRMAP, nodata_out=0)
    fdir_np = np.asarray(fdir)
    acc_np = np.asarray(acc, dtype=np.float64)

    thr = C.STREAM_MIN_AREA_KM2 / cell_km2
    stream = (acc_np >= thr) & valid
    log(f"channel cells: {stream.sum():,} (threshold {thr:.0f} cells)")

    log("HAND (height above nearest drainage)…")
    mask_vf = ViewFinder(affine=tr, shape=dem.shape, crs=f"EPSG:{epsg}", nodata=False)
    hand = np.asarray(grid.compute_hand(fdir, cond, Raster(stream, viewfinder=mask_vf), dirmap=DIRMAP, nodata_out=np.nan),
                      dtype=np.float64)

    # slope (fraction) from the conditioned DEM
    dz_dy, dz_dx = np.gradient(np.where(valid, np.asarray(cond), np.nan), C.CELL_M)
    slope = np.hypot(dz_dx, dz_dy)

    # curve number raster
    cn = np.zeros(lc.shape, dtype=np.float32)
    for cls, val in C.CN_BY_CLASS.items():
        if val is not None:
            cn[lc == cls] = val
    bare = lc == 60
    cn[bare & (slope >= C.BARE_ROCK_SLOPE)] = C.CN_BARE_ROCK
    cn[bare & ~(slope >= C.BARE_ROCK_SLOPE)] = C.CN_BARE_SAND
    cn[(cn == 0) & valid] = 80

    down = downstream_index(fdir_np, valid)
    log("segmenting channel network…")
    seg, starts, cells = segment_streams(stream, down)
    nseg = len(starts)
    log(f"reaches: {nseg}")

    # outlet & downstream reach
    outlet = np.array([c[-1] for c in cells])
    dn_cell = down[outlet]
    dn_seg = np.where(dn_cell != outlet, seg[dn_cell], -1)

    log("labelling catchments…")
    lab = np.where(stream.ravel(), seg, -1)
    lab = np.where(valid.ravel(), lab, -3)
    lab = jump_fill(lab, down, unknown=-1)
    lab = np.where(lab < 0, -1, lab)
    lab2d = lab.reshape(h, w)

    # per-catchment local stats
    flat_valid = lab >= 0
    L = lab[flat_valid]
    area_local = np.bincount(L, minlength=nseg) * cell_km2
    cn_mean = np.bincount(L, weights=cn.ravel()[flat_valid], minlength=nseg) / np.maximum(np.bincount(L, minlength=nseg), 1)
    sl = np.nan_to_num(slope.ravel()[flat_valid])
    slope_mean = np.bincount(L, weights=sl, minlength=nseg) / np.maximum(np.bincount(L, minlength=nseg), 1)
    elev = np.asarray(cond).ravel()
    elev_max = np.full(nseg, -np.inf)
    np.maximum.at(elev_max, L, elev[flat_valid])

    # catchments touching the region edge are truncated (upstream area missing)
    edge = np.zeros((h, w), bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    edge_lab = np.unique(lab2d[edge & (lab2d >= 0)])

    # upstream tree
    children = defaultdict(list)
    for k in range(nseg):
        if dn_seg[k] >= 0:
            children[dn_seg[k]].append(k)
    order = np.argsort(acc_np.ravel()[outlet])  # upstream first
    upstream_sets: list[list[int]] = [None] * nseg
    truncated = np.zeros(nseg, bool)
    truncated[edge_lab] = True
    up_elev_max = elev_max.copy()
    for k in order:
        ups = [k]
        for c in children[k]:
            ups.extend(upstream_sets[c])
            truncated[k] |= truncated[c]
            up_elev_max[k] = max(up_elev_max[k], up_elev_max[c])
        upstream_sets[k] = ups
    area_up = acc_np.ravel()[outlet] * cell_km2

    # time of concentration (Kirpich) with Hack's-law flow length
    a_mi2 = area_up / 2.58999
    length_km = 1.4 * np.power(a_mi2, 0.6) * 1.609344
    relief = np.maximum(up_elev_max - elev[outlet], 1.0)
    s_avg = np.clip(relief / (length_km * 1000), 0.0005, 1)
    tc_h = 0.0078 * np.power(length_km * 3280.84, 0.77) * np.power(s_avg, -0.385) / 60
    tc_h = np.clip(tc_h, 0.25, 48)

    # ───────── vectors ─────────
    _tf = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)

    def to_wgs(geom):
        return shapely.transform(geom, lambda xy: np.column_stack(_tf.transform(xy[:, 0], xy[:, 1])))

    def cell_xy(idx):
        r, c = np.divmod(idx, w)
        x = tr.c + (c + 0.5) * tr.a
        y = tr.f + (r + 0.5) * tr.e
        return x, y

    # rain points (regular lon/lat grid over the bbox)
    minlng, minlat, maxlng, maxlat = C.REGION["bbox"]
    g = C.RAIN_GRID_DEG
    lngs = np.arange(minlng + g / 2, maxlng, g)
    lats = np.arange(minlat + g / 2, maxlat, g)
    rain_pts = [{"id": i, "lng": round(float(x), 4), "lat": round(float(y), 4)}
                for i, (y, x) in enumerate((y, x) for y in lats for x in lngs)]
    log(f"rain points: {len(rain_pts)}")

    # catchment polygons
    log("vectorising catchments…")
    polys = defaultdict(list)
    for geom, val in shapes(lab2d.astype(np.int32), mask=lab2d >= 0, transform=tr):
        polys[int(val)].append(shape(geom))
    catch_feats, rain_of = [], np.zeros(nseg, int)
    for k in range(nseg):
        poly = unary_union(polys[k]).simplify(C.CELL_M)
        cen = to_wgs(poly.centroid)
        rp = int(np.argmin([(p["lng"] - cen.x) ** 2 + (p["lat"] - cen.y) ** 2 for p in rain_pts]))
        rain_of[k] = rp
        catch_feats.append({"type": "Feature", "geometry": mapping(to_wgs(poly)),
                            "properties": {"id": k, "area_km2": round(float(area_local[k]), 4),
                                           "cn": round(float(cn_mean[k]), 1), "slope": round(float(slope_mean[k]), 4),
                                           "rain_point": rp}})

    # flood-prone zones (HAND ≤ threshold) per reach, built-up exposure
    log("flood-prone zones…")
    big = area_up >= C.ZONE_MIN_UPSTREAM_KM2
    zone_mask = (hand <= C.HAND_ZONE_M) & (lab2d >= 0) & big[np.clip(lab2d, 0, None)]
    zone_cells = np.bincount(lab[zone_mask.ravel()], minlength=nseg)
    zone_built = np.bincount(lab[(zone_mask & (lc == C.BUILT_UP_CLASS)).ravel()], minlength=nseg)
    zpolys = defaultdict(list)
    for geom, val in shapes(np.where(zone_mask, lab2d, -1).astype(np.int32), mask=zone_mask, transform=tr):
        zpolys[int(val)].append(shape(geom))
    zone_feats = []
    for k, ps in zpolys.items():
        poly = unary_union(ps).simplify(C.CELL_M / 2)
        if poly.is_empty:
            continue
        zone_feats.append({"type": "Feature", "geometry": mapping(to_wgs(poly)),
                           "properties": {"stream_id": k, "area_km2": round(zone_cells[k] * cell_km2, 4),
                                          "built_up_km2": round(zone_built[k] * cell_km2, 4)}})

    # stream lines
    stream_feats = []
    for k in range(nseg):
        pts = cells[k]
        if dn_seg[k] >= 0:
            pts = np.append(pts, dn_cell[k])  # connect to the downstream reach
        x, y = cell_xy(pts)
        if len(pts) < 2:
            continue
        line = LineString(np.column_stack([x, y])).simplify(C.CELL_M / 2)
        stream_feats.append({"type": "Feature", "geometry": mapping(to_wgs(line)),
                             "properties": {"id": k, "downstream_id": int(dn_seg[k]),
                                            "upstream_km2": round(float(area_up[k]), 3),
                                            "local_km2": round(float(area_local[k]), 4),
                                            "tc_h": round(float(tc_h[k]), 2),
                                            "relief_m": round(float(relief[k]), 1),
                                            "truncated": bool(truncated[k]),
                                            "zone_km2": round(zone_cells[k] * cell_km2, 4),
                                            "zone_built_km2": round(zone_built[k] * cell_km2, 4)}})

    # area-weights: for each reach, upstream catchment area per rain point
    weights = {}
    for k in range(nseg):
        acc_w = defaultdict(float)
        for u in upstream_sets[k]:
            acc_w[int(rain_of[u])] += float(area_local[u])
        weights[k] = {str(p): round(a, 5) for p, a in acc_w.items() if a > 0}
    cn_up = {k: round(float(sum(area_local[u] * cn_mean[u] for u in upstream_sets[k]) /
                            max(sum(area_local[u] for u in upstream_sets[k]), 1e-9)), 2) for k in range(nseg)}
    for f in stream_feats:
        f["properties"]["cn_up"] = cn_up[f["properties"]["id"]]

    def dump(name, feats):
        (out / name).write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False))

    dump("streams.geojson", stream_feats)
    dump("catchments.geojson", catch_feats)
    dump("flood_zones.geojson", zone_feats)
    (out / "rain_points.json").write_text(json.dumps(rain_pts))
    (out / "upstream_weights.json").write_text(json.dumps(weights))
    meta = {"region": C.REGION, "cell_m": C.CELL_M, "grid": [w, h], "reaches": nseg,
            "stream_min_area_km2": C.STREAM_MIN_AREA_KM2, "hand_zone_m": C.HAND_ZONE_M,
            "max_upstream_km2": round(float(area_up.max()), 2),
            "sources": {"dem": "Copernicus GLO-30 (ESA)", "land_cover": "ESA WorldCover 2021 v200"}}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    # preview image for a quick visual sanity check
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(10, 9), dpi=110)
        hs = np.where(valid, np.asarray(cond), np.nan)
        ax.imshow(hs, cmap="terrain", vmin=0, vmax=np.nanpercentile(hs, 99))
        ax.imshow(np.where(zone_mask, 1, np.nan), cmap="autumn", alpha=0.6)
        sr, sc = np.nonzero(stream & (acc_np * cell_km2 >= 5))
        ax.scatter(sc, sr, s=0.05, c="#0b4f8a")
        ax.set_title(f"{C.REGION['slug']}: channels ≥5 km² (blue), HAND ≤ {C.HAND_ZONE_M} m zones (orange)")
        ax.axis("off")
        fig.savefig(out / "preview.png", bbox_inches="tight")
    except ImportError:
        pass
    log(f"done → {out}  ({nseg} reaches, {len(zone_feats)} zones, max upstream {area_up.max():.0f} km²)")


if __name__ == "__main__":
    main()
