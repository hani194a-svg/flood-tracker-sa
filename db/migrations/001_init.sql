-- 001_init.sql — core schema: users, valleys, reports
-- On Supabase, extensions live in the `extensions` schema (already on the search_path).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
  ELSE
    CREATE EXTENSION IF NOT EXISTS postgis;
  END IF;
END $$;

-- ───────────── users ─────────────
CREATE TABLE IF NOT EXISTS public.users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'reporter' CHECK (role IN ('reporter', 'admin')),
  -- Trust score is maintained by triggers in 002_verification.sql
  trust_score     NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (trust_score BETWEEN 0 AND 1),
  verified_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── valleys (wadis / drainage channels) ─────────────
CREATE TABLE IF NOT EXISTS public.valleys (
  id       SERIAL PRIMARY KEY,
  name_ar  TEXT NOT NULL,
  name_en  TEXT,
  geom     GEOMETRY(MultiLineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_valleys_geom ON public.valleys USING GIST (geom);

-- ───────────── reports ─────────────
CREATE TABLE IF NOT EXISTS public.reports (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description  TEXT CHECK (char_length(description) <= 2000),
  intensity    SMALLINT NOT NULL CHECK (intensity BETWEEN 1 AND 5),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  geom         GEOMETRY(Point, 4326) NOT NULL,
  reviewed_by  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_geom           ON public.reports USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON public.reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_user           ON public.reports (user_id);

CREATE OR REPLACE FUNCTION public.fn_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reports_touch ON public.reports;
CREATE TRIGGER trg_reports_touch BEFORE UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();
