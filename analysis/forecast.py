"""Hourly flood-risk forecast for every channel reach in the region.

    python analysis/forecast.py                       # live: Open-Meteo, 5 days history + 3 days ahead
    python analysis/forecast.py --archive 2024-01-05 2024-01-07   # past event from ERA5 reanalysis
    python analysis/forecast.py --scenario jeddah-2009            # documented historical storm
    python analysis/forecast.py --dry-run --scenario jeddah-2009  # print results, write nothing

Schedule the live mode every 1–3 h (cron / GitHub Actions / Supabase pg_cron + edge function).
Each run notifies listeners on the Postgres channel `forecast_ready` with the run id.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

import config as C
from db import connect
from hydrology import run_model, LEVELS_AR

UTC = timezone.utc
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Documented storms, applied uniformly over the region (a simplification: real storms vary in space).
SCENARIOS = {
    "jeddah-2009": {
        "label": "سيول جدة 25 نوفمبر 2009",
        "start": "2009-11-25T05:00:00Z",                 # 08:00 Saudi time
        "hourly_mm": [15, 35, 28, 12],                   # > 90 mm in ~4 h (PME / NCM reports)
        "note": "أكثر من 90 ملم خلال نحو 4 ساعات (الرئاسة العامة للأرصاد وحماية البيئة)",
    },
    "jeddah-2022": {
        "label": "أمطار جدة 24 نوفمبر 2022",
        "start": "2022-11-24T05:00:00Z",
        "hourly_mm": [12, 30, 45, 48, 30, 14],          # 179 mm in ~6 h (NCM, Jeddah)
        "note": "179 ملم خلال نحو 6 ساعات (المركز الوطني للأرصاد)",
    },
    "light-shower": {
        "label": "زخة خفيفة (للمقارنة)",
        "start": "2025-01-01T09:00:00Z",
        "hourly_mm": [4, 7, 3],
        "note": "14 ملم خلال 3 ساعات",
    },
}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def get_json(url, params, retries=3):
    q = urllib.parse.urlencode(params)
    for i in range(retries):
        try:
            with urllib.request.urlopen(f"{url}?{q}", timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            body = getattr(e, "read", lambda: b"")().decode(errors="ignore")[:200]
            if i == retries - 1:
                raise SystemExit(f"weather request failed: {e} {body}")
            time.sleep(2 ** i * 3)


def fetch_open_meteo(points, url, extra):
    """Hourly precipitation for many points in one request (Open-Meteo multi-location)."""
    data = get_json(url, {
        "latitude": ",".join(str(p[1]) for p in points),
        "longitude": ",".join(str(p[0]) for p in points),
        "hourly": "precipitation", "timezone": "GMT", **extra,
    })
    data = data if isinstance(data, list) else [data]
    times = [datetime.fromisoformat(t).replace(tzinfo=UTC) for t in data[0]["hourly"]["time"]]
    rain = np.array([[v or 0.0 for v in d["hourly"]["precipitation"]] for d in data], dtype=float)
    return times, rain


def load_region(cur):
    cur.execute("SELECT id FROM public.regions WHERE slug = %s", (C.REGION["slug"],))
    row = cur.fetchone()
    if not row:
        raise SystemExit("region not loaded — run terrain.py and load_db.py first")
    region_id = row[0]
    cur.execute("SELECT id, ST_X(geom), ST_Y(geom) FROM public.rain_points WHERE region_id = %s ORDER BY id", (region_id,))
    rps = cur.fetchall()
    cur.execute("""SELECT id, upstream_km2, tc_h, cn_up, zone_built_km2, truncated
                   FROM public.streams WHERE region_id = %s ORDER BY id""", (region_id,))
    st = cur.fetchall()
    sidx = {s[0]: i for i, s in enumerate(st)}
    pidx = {p[0]: i for i, p in enumerate(rps)}
    W = np.zeros((len(st), len(rps)))
    cur.execute("""SELECT w.stream_id, w.rain_point_id, w.area_km2 FROM public.stream_rain_weights w
                   JOIN public.streams s ON s.id = w.stream_id WHERE s.region_id = %s""", (region_id,))
    for s_id, p_id, a in cur.fetchall():
        W[sidx[s_id], pidx[p_id]] = float(a)
    arr = lambda k: np.array([float(s[k]) for s in st])
    return {"region_id": region_id, "rain_points": rps, "stream_ids": [s[0] for s in st],
            "weights": W, "area": arr(1), "tc": arr(2), "cn": arr(3), "built": arr(4),
            "truncated": np.array([s[5] for s in st])}


def build_inputs(args, reg):
    pts = [(p[1], p[2]) for p in reg["rain_points"]]
    if args.scenario:
        sc = SCENARIOS[args.scenario]
        start = datetime.fromisoformat(sc["start"].replace("Z", "+00:00"))
        n_ant, n_after = 120, 12                                   # dry 5 days before, 12 h after
        hours = [start + timedelta(hours=h - n_ant) for h in range(n_ant + len(sc["hourly_mm"]) + n_after)]
        series = np.zeros(len(hours))
        series[n_ant:n_ant + len(sc["hourly_mm"])] = sc["hourly_mm"]
        rain = np.tile(series, (len(pts), 1))
        return "scenario", sc["label"], f"scenario:{args.scenario}", hours, rain, n_ant, {"note": sc["note"]}
    if args.archive:
        d0 = datetime.fromisoformat(args.archive[0]).replace(tzinfo=UTC)
        d1 = datetime.fromisoformat(args.archive[1]).replace(tzinfo=UTC)
        times, rain = fetch_open_meteo(pts, ARCHIVE_URL, {
            "start_date": (d0 - timedelta(days=5)).date().isoformat(), "end_date": d1.date().isoformat()})
        n_ant = next(i for i, t in enumerate(times) if t >= d0)
        return "archive", f"أرشيف {args.archive[0]} – {args.archive[1]}", "open-meteo:era5", times, rain, n_ant, {}
    times, rain = fetch_open_meteo(pts, FORECAST_URL, {"past_days": 5, "forecast_days": args.days})
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    n_ant = next(i for i, t in enumerate(times) if t >= now)
    return "forecast", None, "open-meteo:best_match", times, rain, n_ant, {}


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--scenario", choices=sorted(SCENARIOS))
    g.add_argument("--archive", nargs=2, metavar=("START", "END"))
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with connect() as conn, conn.cursor() as cur:
        reg = load_region(cur)
        kind, label, source, times, rain, n_ant, extra = build_inputs(args, reg)
        log(f"{kind}: {len(reg['rain_points'])} rain points × {len(times)} h ({n_ant} h history), "
            f"max hourly {rain.max():.1f} mm, max total {rain[:, n_ant:].sum(axis=1).max():.1f} mm")

        res = run_model(rain, reg["weights"], reg["area"], reg["tc"], reg["cn"], reg["built"], n_ant)
        ftimes = times[n_ant:]
        lvl = res["level"]
        max_lvl = int(lvl.max()) if lvl.size else 1
        counts = {k: int((lvl.max(axis=1) == k).sum()) for k in range(1, 6)}
        log(f"reaches by max level: {counts}")

        # report on the reaches that matter most
        worst = np.argsort(-(lvl.max(axis=1) * 1e4 + res["peak"].max(axis=1)))[:8]
        for i in worst:
            j = int(res["peak"][i].argmax())
            log(f"  reach {reg['stream_ids'][i]}: {reg['area'][i]:.0f} km², level {lvl[i].max()} "
                f"({LEVELS_AR[int(lvl[i].max())]}), peak {res['peak'][i, j]:.0f} m³/s, runoff {res['runoff'][i, j]:.0f} mm"
                f"{' [basin truncated]' if reg['truncated'][i] else ''}")

        if args.dry_run:
            print(json.dumps({"kind": kind, "max_level": max_lvl, "levels": counts}))
            return

        params = {"hours": len(ftimes), "history_h": n_ant, **extra}
        cur.execute("""INSERT INTO public.forecast_runs (region_id, kind, label, source, start_time, end_time, params, max_level)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (reg["region_id"], kind, label, source, ftimes[0], ftimes[-1] + timedelta(hours=1),
                     json.dumps(params, ensure_ascii=False), max_lvl))
        run_id = cur.fetchone()[0]

        with cur.copy("COPY public.forecast_rain (run_id, rain_point_id, valid_time, precip_mm) FROM STDIN") as cp:
            for pi, p in enumerate(reg["rain_points"]):
                for h, t in enumerate(times):
                    if rain[pi, h] > 0 or h >= n_ant:
                        cp.write_row((run_id, p[0], t, float(rain[pi, h])))

        risky = np.argwhere(lvl >= 2)
        off = res["peak_offset_h"]
        with cur.copy("""COPY public.stream_forecasts (run_id, stream_id, valid_time, rain_mm, runoff_mm, peak_m3s, level)
                         FROM STDIN""") as cp:
            seen = set()
            for i, h in risky:
                t = ftimes[h] + timedelta(hours=int(off[i]))
                key = (i, t)
                if key in seen:
                    continue
                seen.add(key)
                cp.write_row((run_id, reg["stream_ids"][i], t, float(res["window_rain"][i, h]),
                              float(res["runoff"][i, h]), float(res["peak"][i, h]), int(lvl[i, h])))
        with cur.copy("""COPY public.stream_forecast_summary (run_id, stream_id, max_level, max_peak_m3s, max_runoff_mm,
                                                                time_of_max, first_level3_at) FROM STDIN""") as cp:
            for i in np.flatnonzero(lvl.max(axis=1) >= 2):
                j = int(np.lexsort((res["peak"][i], lvl[i]))[-1])
                l3 = np.flatnonzero(lvl[i] >= 3)
                cp.write_row((run_id, reg["stream_ids"][i], int(lvl[i].max()), float(res["peak"][i].max()),
                              float(res["runoff"][i].max()), ftimes[j] + timedelta(hours=int(off[i])),
                              ftimes[l3[0]] + timedelta(hours=int(off[i])) if len(l3) else None))
        cur.execute("SELECT pg_notify('forecast_ready', %s)", (json.dumps({"run_id": run_id, "kind": kind, "max_level": max_lvl}),))
        conn.commit()
        log(f"saved run {run_id} ({len(risky)} risky reach-hours)")
        print(json.dumps({"run_id": run_id, "kind": kind, "max_level": max_lvl, "levels": counts}))


if __name__ == "__main__":
    main()
