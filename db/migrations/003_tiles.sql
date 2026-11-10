-- 003_tiles.sql — Martin function source for public, verified reports.
-- Exposes only safe columns (no user_id, no description) to the public map.
CREATE OR REPLACE FUNCTION public.verified_reports_tiles(z INTEGER, x INTEGER, y INTEGER, query_params JSON DEFAULT '{}'::JSON)
RETURNS BYTEA
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ST_AsMVT(t, 'verified_reports', 4096, 'geom')
  FROM (
    SELECT r.id, r.title, r.intensity, r.confidence_score,
           EXTRACT(EPOCH FROM r.created_at)::BIGINT AS created_ts,
           ST_AsMVTGeom(ST_Transform(r.geom, 3857), ST_TileEnvelope(z, x, y), 4096, 64, TRUE) AS geom
    FROM public.reports r
    WHERE r.status = 'verified'
      AND r.created_at >= now() - INTERVAL '48 hours'
      AND r.geom && ST_Transform(ST_TileEnvelope(z, x, y), 4326)
  ) t;
$$;
