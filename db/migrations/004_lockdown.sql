-- 004_lockdown.sql — close the database to everything except the backend & Martin.
--
-- Supabase publishes every table in `public` through its REST API (PostgREST) to the
-- `anon` and `authenticated` roles. This app never uses that API: all access goes
-- through the Express backend and Martin, which connect as the database owner.
-- Without this migration, anyone holding the public anon key could read
-- users.password_hash or call fn_score_report directly.
--
-- Safe on plain PostgreSQL too: role-specific statements are skipped when the
-- Supabase roles do not exist.

-- 1) RLS on every table with NO policies → API roles see nothing.
--    The table owner (postgres, used by the backend and Martin) bypasses RLS.
ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.valleys             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.schema_migrations ENABLE ROW LEVEL SECURITY;

-- 2) Functions are executable by PUBLIC by default — revoke.
REVOKE EXECUTE ON FUNCTION public.fn_score_report(BIGINT)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_process_report(BIGINT)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_active_clusters(INTEGER)   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.verified_reports_tiles(INTEGER, INTEGER, INTEGER, JSON) FROM PUBLIC;

-- 3) Belt and braces for Supabase's API roles (grants, not just RLS).
DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
