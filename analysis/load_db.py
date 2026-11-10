"""Load terrain products (analysis/data/out/<region>) into PostGIS.

    DATABASE_URL=… python analysis/load_db.py --region riyadh

Replaces the region's previous terrain data in one transaction (forecast runs for the
region are removed with it — run forecast.py again afterwards).
"""
import json

import config as C
from db import connect


def main():
    out = C.OUT / C.REGION["slug"]
    meta = json.loads((out / "meta.json").read_text())
    streams = json.loads((out / "streams.geojson").read_text())["features"]
    catchments = json.loads((out / "catchments.geojson").read_text())["features"]
    zones = json.loads((out / "flood_zones.geojson").read_text())["features"]
    rain_pts = json.loads((out / "rain_points.json").read_text())
    weights = json.loads((out / "upstream_weights.json").read_text())
    minx, miny, maxx, maxy = C.REGION["bbox"]

    with connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM public.regions WHERE slug = %s", (C.REGION["slug"],))
        cur.execute(
            """INSERT INTO public.regions (slug, name_ar, bbox, meta)
               VALUES (%s, %s, ST_MakeEnvelope(%s, %s, %s, %s, 4326), %s) RETURNING id""",
            (C.REGION["slug"], C.REGION["name_ar"], minx, miny, maxx, maxy, json.dumps(meta)))
        region_id = cur.fetchone()[0]

        rp_ids = {}
        for p in rain_pts:
            cur.execute("""INSERT INTO public.rain_points (region_id, local_id, geom)
                           VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)) RETURNING id""",
                        (region_id, p["id"], p["lng"], p["lat"]))
            rp_ids[p["id"]] = cur.fetchone()[0]

        with cur.copy("""COPY public.streams (region_id, local_id, geom, upstream_km2, local_km2, tc_h, relief_m,
                                                 cn_up, truncated, zone_km2, zone_built_km2) FROM STDIN""") as cp:
            for f in streams:
                p = f["properties"]
                cp.write_row((region_id, p["id"], f"SRID=4326;{_wkt(f['geometry'])}", p["upstream_km2"], p["local_km2"],
                              p["tc_h"], p["relief_m"], p["cn_up"], p["truncated"], p["zone_km2"], p["zone_built_km2"]))
        cur.execute("SELECT local_id, id FROM public.streams WHERE region_id = %s", (region_id,))
        sid = dict(cur.fetchall())

        cur.execute("CREATE TEMP TABLE links (local_id INT, down_local INT) ON COMMIT DROP")
        with cur.copy("COPY links FROM STDIN") as cp:
            for f in streams:
                if f["properties"]["downstream_id"] >= 0:
                    cp.write_row((f["properties"]["id"], f["properties"]["downstream_id"]))
        cur.execute("""UPDATE public.streams s SET downstream_id = d.id
                       FROM links l JOIN public.streams d ON d.region_id = %s AND d.local_id = l.down_local
                       WHERE s.region_id = %s AND s.local_id = l.local_id""", (region_id, region_id))

        with cur.copy("COPY public.catchments (stream_id, geom, area_km2, cn, slope, rain_point_id) FROM STDIN") as cp:
            for f in catchments:
                p = f["properties"]
                if p["id"] in sid:
                    cp.write_row((sid[p["id"]], f"SRID=4326;{_wkt(f['geometry'], multi=True)}", p["area_km2"],
                                  p["cn"], p["slope"], rp_ids[p["rain_point"]]))
        with cur.copy("COPY public.flood_zones (stream_id, geom, area_km2, built_up_km2) FROM STDIN") as cp:
            for f in zones:
                p = f["properties"]
                if p["stream_id"] in sid:
                    cp.write_row((sid[p["stream_id"]], f"SRID=4326;{_wkt(f['geometry'], multi=True)}",
                                  p["area_km2"], p["built_up_km2"]))
        with cur.copy("COPY public.stream_rain_weights (stream_id, rain_point_id, area_km2) FROM STDIN") as cp:
            for k, wmap in weights.items():
                if int(k) in sid:
                    for rp, a in wmap.items():
                        cp.write_row((sid[int(k)], rp_ids[int(rp)], a))

        # match larger channels to named wadis (valleys table) within 300 m
        cur.execute("""UPDATE public.streams s SET valley_id = (
                         SELECT v.id FROM public.valleys v
                         WHERE ST_DWithin(v.geom::geography, s.geom::geography, 300)
                         ORDER BY v.geom <-> s.geom LIMIT 1)
                       WHERE s.region_id = %s AND s.upstream_km2 >= 5""", (region_id,))
        cur.execute("""SELECT COUNT(*), COUNT(valley_id) FROM public.streams WHERE region_id = %s""", (region_id,))
        n, named = cur.fetchone()
        print(f"region {C.REGION['slug']} (id {region_id}): {n} reaches ({named} matched to named wadis), "
              f"{len(catchments)} catchments, {len(zones)} flood zones, {len(rain_pts)} rain points")


def _wkt(geom, multi=False):
    from shapely.geometry import shape
    from shapely.geometry.multipolygon import MultiPolygon
    g = shape(geom)
    if multi and g.geom_type == "Polygon":
        g = MultiPolygon([g])
    return g.wkt


if __name__ == "__main__":
    C.use_region()
    main()
