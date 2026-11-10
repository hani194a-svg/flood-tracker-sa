-- 006_forecast.sql — weather + terrain flood forecasting.
--
-- Static terrain products (from analysis/terrain.py):
--   regions, rain_points, streams (channel reaches), catchments, flood_zones, stream_rain_weights
-- Forecast products (from analysis/forecast.py, hourly):
--   forecast_runs, forecast_rain, stream_forecasts (risky hours only), stream_forecast_summary

CREATE TABLE IF NOT EXISTS public.regions (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name_ar    TEXT NOT NULL,
  bbox       GEOMETRY(Polygon, 4326) NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}',
  loaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rain_points (
  id         BIGSERIAL PRIMARY KEY,
  region_id  INTEGER NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  local_id   INTEGER NOT NULL,
  geom       GEOMETRY(Point, 4326) NOT NULL,
  UNIQUE (region_id, local_id)
);

CREATE TABLE IF NOT EXISTS public.streams (
  id              BIGSERIAL PRIMARY KEY,
  region_id       INTEGER NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  local_id        INTEGER NOT NULL,
  downstream_id   BIGINT REFERENCES public.streams(id) ON DELETE SET NULL,
  geom            GEOMETRY(LineString, 4326) NOT NULL,
  upstream_km2    NUMERIC(10,3) NOT NULL,   -- total area draining to the reach outlet
  local_km2       NUMERIC(10,4) NOT NULL,   -- area draining directly to this reach
  tc_h            NUMERIC(6,2)  NOT NULL,   -- time of concentration (Kirpich)
  relief_m        NUMERIC(8,1),
  cn_up           NUMERIC(5,2)  NOT NULL,   -- area-weighted SCS curve number upstream
  truncated       BOOLEAN NOT NULL DEFAULT FALSE, -- upstream basin extends beyond the region
  zone_km2        NUMERIC(10,4) NOT NULL DEFAULT 0,  -- flood-prone (HAND) area along the reach
  zone_built_km2  NUMERIC(10,4) NOT NULL DEFAULT 0,  -- built-up land inside that zone
  valley_id       INTEGER REFERENCES public.valleys(id) ON DELETE SET NULL, -- named wadi, if matched
  UNIQUE (region_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_streams_geom ON public.streams USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_streams_upstream ON public.streams (region_id, upstream_km2 DESC);

CREATE TABLE IF NOT EXISTS public.catchments (
  stream_id      BIGINT PRIMARY KEY REFERENCES public.streams(id) ON DELETE CASCADE,
  geom           GEOMETRY(MultiPolygon, 4326) NOT NULL,
  area_km2       NUMERIC(10,4) NOT NULL,
  cn             NUMERIC(5,2) NOT NULL,
  slope          NUMERIC(6,4),
  rain_point_id  BIGINT REFERENCES public.rain_points(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_catchments_geom ON public.catchments USING GIST (geom);

CREATE TABLE IF NOT EXISTS public.flood_zones (
  stream_id     BIGINT PRIMARY KEY REFERENCES public.streams(id) ON DELETE CASCADE,
  geom          GEOMETRY(MultiPolygon, 4326) NOT NULL,
  area_km2      NUMERIC(10,4) NOT NULL,
  built_up_km2  NUMERIC(10,4) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flood_zones_geom ON public.flood_zones USING GIST (geom);

-- For each reach: how much of its upstream area each rain point represents.
CREATE TABLE IF NOT EXISTS public.stream_rain_weights (
  stream_id      BIGINT NOT NULL REFERENCES public.streams(id) ON DELETE CASCADE,
  rain_point_id  BIGINT NOT NULL REFERENCES public.rain_points(id) ON DELETE CASCADE,
  area_km2       NUMERIC(10,5) NOT NULL,
  PRIMARY KEY (stream_id, rain_point_id)
);

-- ───────────── forecasts ─────────────
CREATE TABLE IF NOT EXISTS public.forecast_runs (
  id          BIGSERIAL PRIMARY KEY,
  region_id   INTEGER NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('forecast', 'archive', 'scenario')),
  label       TEXT,
  source      TEXT NOT NULL,              -- e.g. open-meteo:best_match
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}',
  max_level   SMALLINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_latest ON public.forecast_runs (region_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS public.forecast_rain (
  run_id         BIGINT NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  rain_point_id  BIGINT NOT NULL REFERENCES public.rain_points(id) ON DELETE CASCADE,
  valid_time     TIMESTAMPTZ NOT NULL,
  precip_mm      REAL NOT NULL,
  PRIMARY KEY (run_id, rain_point_id, valid_time)
);

-- Only hours with level ≥ 2 are stored; absent hours mean level 1 (no significant risk).
CREATE TABLE IF NOT EXISTS public.stream_forecasts (
  run_id      BIGINT NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  stream_id   BIGINT NOT NULL REFERENCES public.streams(id) ON DELETE CASCADE,
  valid_time  TIMESTAMPTZ NOT NULL,   -- expected time of peak flow
  rain_mm     REAL NOT NULL,          -- basin-average rain over the critical window
  runoff_mm   REAL NOT NULL,
  peak_m3s    REAL NOT NULL,
  level       SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 5),
  PRIMARY KEY (run_id, stream_id, valid_time)
);
CREATE INDEX IF NOT EXISTS idx_stream_forecasts_time ON public.stream_forecasts (run_id, valid_time);

CREATE TABLE IF NOT EXISTS public.stream_forecast_summary (
  run_id          BIGINT NOT NULL REFERENCES public.forecast_runs(id) ON DELETE CASCADE,
  stream_id       BIGINT NOT NULL REFERENCES public.streams(id) ON DELETE CASCADE,
  max_level       SMALLINT NOT NULL,
  max_peak_m3s    REAL NOT NULL,
  max_runoff_mm   REAL NOT NULL,
  time_of_max     TIMESTAMPTZ,
  first_level3_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, stream_id)
);
CREATE INDEX IF NOT EXISTS idx_summary_level ON public.stream_forecast_summary (run_id, max_level DESC);

-- ───────────── forecast as a report-verification signal ─────────────
-- Highest forecast level among reaches within `radius_m` of a point, ±3 h around `at`,
-- from the newest real forecast (not scenarios) covering that time. NULL = no forecast.
CREATE OR REPLACE FUNCTION public.fn_forecast_level_at(p_geom GEOMETRY, p_at TIMESTAMPTZ, p_radius_m INTEGER DEFAULT 1000)
RETURNS SMALLINT
LANGUAGE sql STABLE AS $$
  WITH run AS (
    SELECT fr.id FROM public.forecast_runs fr
    JOIN public.regions rg ON rg.id = fr.region_id
    WHERE fr.kind IN ('forecast', 'archive')
      AND p_at BETWEEN fr.start_time AND fr.end_time
      AND ST_Intersects(rg.bbox, p_geom)
    ORDER BY fr.created_at DESC
    LIMIT 1
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM run) THEN NULL
              ELSE COALESCE((
                SELECT MAX(sf.level) FROM public.stream_forecasts sf
                JOIN public.streams s ON s.id = sf.stream_id
                WHERE sf.run_id = (SELECT id FROM run)
                  AND sf.valid_time BETWEEN p_at - INTERVAL '3 hours' AND p_at + INTERVAL '3 hours'
                  AND ST_DWithin(s.geom::geography, p_geom::geography, p_radius_m)), 1)
         END::SMALLINT;
$$;

ALTER TABLE public.verification_config
  ADD COLUMN IF NOT EXISTS weight_forecast NUMERIC NOT NULL DEFAULT 25;
-- Rebalance: the forecast now carries a quarter of the score. Weights still sum to 100.
UPDATE public.verification_config SET weight_valley = 30, weight_corroboration = 30, weight_trust = 15, weight_forecast = 25
WHERE weight_valley = 40 AND weight_corroboration = 35 AND weight_trust = 25;

ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS forecast_level SMALLINT;

-- Same as 002's fn_score_report, plus: (a) proximity also counts terrain-derived channels
-- (≥ 5 km² upstream), (b) the forecast risk at the report's place and time.
-- Outside any forecast region the forecast weight is redistributed proportionally.
CREATE OR REPLACE FUNCTION public.fn_score_report(p_report_id BIGINT)
RETURNS public.reports
LANGUAGE plpgsql AS $$
DECLARE
  cfg        public.verification_config%ROWTYPE;
  r          public.reports%ROWTYPE;
  v_id       INTEGER;
  v_dist     DOUBLE PRECISION;
  s_dist     DOUBLE PRECISION;
  s_valley   INTEGER;
  v_corr     INTEGER;
  v_trust    NUMERIC;
  v_level    SMALLINT;
  f_valley   NUMERIC;
  f_corr     NUMERIC;
  f_fc       NUMERIC;
  w_sum      NUMERIC;
  v_score    NUMERIC;
BEGIN
  SELECT * INTO cfg FROM public.verification_config LIMIT 1;
  SELECT * INTO r   FROM public.reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT v.id, ST_Distance(v.geom::geography, r.geom::geography) INTO v_id, v_dist
  FROM public.valleys v ORDER BY v.geom <-> r.geom LIMIT 1;

  SELECT ST_Distance(s.geom::geography, r.geom::geography), s.valley_id INTO s_dist, s_valley
  FROM public.streams s WHERE s.upstream_km2 >= 5 ORDER BY s.geom <-> r.geom LIMIT 1;

  IF s_dist IS NOT NULL AND (v_dist IS NULL OR s_dist < v_dist) THEN
    v_dist := s_dist;
    v_id := s_valley;   -- the named wadi this channel was matched to, if any
  END IF;

  IF v_dist IS NULL THEN
    f_valley := 0;
  ELSIF v_dist <= cfg.valley_buffer_m THEN
    f_valley := 1;
  ELSE
    f_valley := GREATEST(0, 1 - (v_dist - cfg.valley_buffer_m) / NULLIF(cfg.valley_falloff_m, 0));
  END IF;

  SELECT COUNT(DISTINCT COALESCE(o.user_id::text, 'anon-' || o.id)) INTO v_corr
  FROM public.reports o
  WHERE o.id <> r.id
    AND o.status <> 'rejected'
    AND (r.user_id IS NULL OR o.user_id IS DISTINCT FROM r.user_id)
    AND o.created_at BETWEEN r.created_at - make_interval(mins => cfg.corroboration_window_min)
                         AND r.created_at + make_interval(mins => cfg.corroboration_window_min)
    AND ST_DWithin(o.geom::geography, r.geom::geography, cfg.corroboration_radius_m);
  f_corr := LEAST(v_corr, cfg.corroboration_saturation)::NUMERIC / cfg.corroboration_saturation;

  IF r.user_id IS NULL THEN
    v_trust := cfg.anonymous_trust;
  ELSE
    SELECT trust_score INTO v_trust FROM public.users WHERE id = r.user_id;
    v_trust := COALESCE(v_trust, cfg.anonymous_trust);
  END IF;

  v_level := public.fn_forecast_level_at(r.geom, r.created_at, cfg.corroboration_radius_m);
  -- level 1 → 0, 2 → 0.4, 3 → 0.7, 4–5 → 1
  f_fc := CASE v_level WHEN 1 THEN 0 WHEN 2 THEN 0.4 WHEN 3 THEN 0.7 WHEN 4 THEN 1 WHEN 5 THEN 1 END;

  IF v_level IS NULL THEN
    w_sum := cfg.weight_valley + cfg.weight_corroboration + cfg.weight_trust;
    v_score := 100 * (cfg.weight_valley * f_valley + cfg.weight_corroboration * f_corr + cfg.weight_trust * v_trust) / w_sum;
  ELSE
    v_score := cfg.weight_valley * f_valley + cfg.weight_corroboration * f_corr
             + cfg.weight_trust * v_trust + cfg.weight_forecast * f_fc;
  END IF;
  v_score := ROUND(v_score, 2);

  UPDATE public.reports SET
    valley_id           = CASE WHEN f_valley > 0 THEN v_id END,
    valley_distance_m   = ROUND(v_dist::NUMERIC, 1),
    corroboration_count = v_corr,
    forecast_level      = v_level,
    confidence_score    = v_score,
    status        = CASE WHEN status = 'pending' AND v_score >= cfg.auto_verify_threshold
                         THEN 'verified' ELSE status END,
    auto_verified = auto_verified OR (status = 'pending' AND v_score >= cfg.auto_verify_threshold)
  WHERE id = r.id
  RETURNING * INTO r;

  RETURN r;
END $$;

-- ───────────── Martin tiles: reaches coloured by the current forecast ─────────────
CREATE OR REPLACE FUNCTION public.stream_risk_tiles(z INTEGER, x INTEGER, y INTEGER, query_params JSON DEFAULT '{}'::JSON)
RETURNS BYTEA
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH latest AS (
    SELECT DISTINCT ON (region_id) id, region_id FROM public.forecast_runs
    WHERE kind = 'forecast' ORDER BY region_id, created_at DESC
  )
  SELECT ST_AsMVT(t, 'stream_risk', 4096, 'geom')
  FROM (
    SELECT s.id, s.upstream_km2, COALESCE(sm.max_level, 1) AS max_level, sm.time_of_max,
           ST_AsMVTGeom(ST_Transform(s.geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, TRUE) AS geom
    FROM public.streams s
    LEFT JOIN latest l ON l.region_id = s.region_id
    LEFT JOIN public.stream_forecast_summary sm ON sm.run_id = l.id AND sm.stream_id = s.id
    WHERE s.geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)
      AND s.upstream_km2 >= CASE WHEN z < 10 THEN 20 WHEN z < 12 THEN 5 ELSE 1 END
  ) t;
$$;

-- ───────────── lockdown (same policy as 004) ─────────────
ALTER TABLE public.regions                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rain_points             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streams                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catchments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flood_zones             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stream_rain_weights     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forecast_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forecast_rain           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stream_forecasts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stream_forecast_summary ENABLE ROW LEVEL SECURITY;
REVOKE EXECUTE ON FUNCTION public.fn_forecast_level_at(GEOMETRY, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_score_report(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stream_risk_tiles(INTEGER, INTEGER, INTEGER, JSON) FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;
