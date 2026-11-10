-- 005_valley_sources.sql — track where each valley came from, so imports can
-- upsert in place (keeping reports.valley_id links) instead of wiping the table.
ALTER TABLE public.valleys
  ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'manual',   -- manual | sample | osm
  ADD COLUMN IF NOT EXISTS source_key TEXT,                             -- e.g. osm:way:123456
  ADD COLUMN IF NOT EXISTS waterway   TEXT,                             -- wadi | river | stream
  ADD COLUMN IF NOT EXISTS osm_ids    BIGINT[],
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Many small wadis in OSM have no name; they still matter for proximity scoring.
ALTER TABLE public.valleys ALTER COLUMN name_ar DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_valleys_source_key ON public.valleys (source_key);

-- Mark the development seed rows so they can be removed once real data is loaded.
UPDATE public.valleys SET source = 'sample'
WHERE source = 'manual' AND name_en IN ('Wadi Hanifah', 'Wadi Fatimah', 'Wadi Baysh');
