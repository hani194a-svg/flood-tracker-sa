-- 002_verification.sql — anti-fraud / verification engine
--
-- Every report gets a confidence score (0–100) built from three signals:
--   1. Valley proximity   — is the report on/near a mapped wadi?        (weight_valley)
--   2. Corroboration      — independent reports nearby in time & space? (weight_corroboration)
--   3. Reporter trust     — how accurate has this user been historically? (weight_trust)
-- Reports at or above auto_verify_threshold are auto-verified.
-- Only MANUAL admin decisions feed back into the trust score (avoids feedback loops).

-- ───────────── tunables (single-row config) ─────────────
CREATE TABLE IF NOT EXISTS public.verification_config (
  id                        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  valley_buffer_m           INTEGER NOT NULL DEFAULT 500,   -- full valley score inside this distance
  valley_falloff_m          INTEGER NOT NULL DEFAULT 1500,  -- score decays linearly to 0 at buffer + falloff
  corroboration_radius_m    INTEGER NOT NULL DEFAULT 1000,
  corroboration_window_min  INTEGER NOT NULL DEFAULT 60,
  corroboration_saturation  INTEGER NOT NULL DEFAULT 4,     -- this many independent reports = full score
  weight_valley             NUMERIC NOT NULL DEFAULT 40,
  weight_corroboration      NUMERIC NOT NULL DEFAULT 35,
  weight_trust              NUMERIC NOT NULL DEFAULT 25,
  anonymous_trust           NUMERIC NOT NULL DEFAULT 0.300,
  auto_verify_threshold     NUMERIC NOT NULL DEFAULT 80,
  trust_prior_alpha         NUMERIC NOT NULL DEFAULT 2,     -- Bayesian prior: 2 verified …
  trust_prior_beta          NUMERIC NOT NULL DEFAULT 2,     -- … and 2 rejected → new users start at 0.5
  cluster_alert_min_reports INTEGER NOT NULL DEFAULT 5
);
INSERT INTO public.verification_config DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ───────────── new report columns ─────────────
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS valley_id           INTEGER REFERENCES public.valleys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS valley_distance_m   NUMERIC(10,1),
  ADD COLUMN IF NOT EXISTS corroboration_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence_score    NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS auto_verified       BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_reports_confidence ON public.reports (status, confidence_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_reports_created    ON public.reports (created_at);

-- ───────────── scoring ─────────────
-- Scores one report, persists the result, and auto-verifies it if it crosses the threshold.
CREATE OR REPLACE FUNCTION public.fn_score_report(p_report_id BIGINT)
RETURNS public.reports
LANGUAGE plpgsql AS $$
DECLARE
  cfg        public.verification_config%ROWTYPE;
  r          public.reports%ROWTYPE;
  v_id       INTEGER;
  v_dist     DOUBLE PRECISION;
  v_corr     INTEGER;
  v_trust    NUMERIC;
  f_valley   NUMERIC;
  f_corr     NUMERIC;
  v_score    NUMERIC;
BEGIN
  SELECT * INTO cfg FROM public.verification_config LIMIT 1;
  SELECT * INTO r   FROM public.reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 1) nearest valley (index-assisted KNN, then exact geodesic distance)
  SELECT v.id, ST_Distance(v.geom::geography, r.geom::geography)
    INTO v_id, v_dist
  FROM public.valleys v
  ORDER BY v.geom <-> r.geom
  LIMIT 1;

  IF v_dist IS NULL THEN
    f_valley := 0;
  ELSIF v_dist <= cfg.valley_buffer_m THEN
    f_valley := 1;
  ELSE
    f_valley := GREATEST(0, 1 - (v_dist - cfg.valley_buffer_m) / NULLIF(cfg.valley_falloff_m, 0));
  END IF;

  -- 2) corroboration: distinct independent reporters nearby within ± window, excluding
  --    rejected reports and the reporter themself. Anonymous reports each count once.
  SELECT COUNT(DISTINCT COALESCE(o.user_id::text, 'anon-' || o.id))
    INTO v_corr
  FROM public.reports o
  WHERE o.id <> r.id
    AND o.status <> 'rejected'
    AND (r.user_id IS NULL OR o.user_id IS DISTINCT FROM r.user_id)
    AND o.created_at BETWEEN r.created_at - make_interval(mins => cfg.corroboration_window_min)
                         AND r.created_at + make_interval(mins => cfg.corroboration_window_min)
    AND ST_DWithin(o.geom::geography, r.geom::geography, cfg.corroboration_radius_m);

  f_corr := LEAST(v_corr, cfg.corroboration_saturation)::NUMERIC / cfg.corroboration_saturation;

  -- 3) reporter trust
  IF r.user_id IS NULL THEN
    v_trust := cfg.anonymous_trust;
  ELSE
    SELECT trust_score INTO v_trust FROM public.users WHERE id = r.user_id;
    v_trust := COALESCE(v_trust, cfg.anonymous_trust);
  END IF;

  v_score := ROUND(
      cfg.weight_valley        * f_valley
    + cfg.weight_corroboration * f_corr
    + cfg.weight_trust         * v_trust, 2);

  UPDATE public.reports SET
    valley_id           = CASE WHEN f_valley > 0 THEN v_id END,
    valley_distance_m   = ROUND(v_dist::NUMERIC, 1),
    corroboration_count = v_corr,
    confidence_score    = v_score,
    status        = CASE WHEN status = 'pending' AND v_score >= cfg.auto_verify_threshold
                         THEN 'verified' ELSE status END,
    auto_verified = auto_verified OR (status = 'pending' AND v_score >= cfg.auto_verify_threshold)
  WHERE id = r.id
  RETURNING * INTO r;

  RETURN r;
END $$;

-- Scores a new report and re-scores pending neighbours whose corroboration just changed.
-- Returns every report that was (re)scored so the API can broadcast the changes.
CREATE OR REPLACE FUNCTION public.fn_process_report(p_report_id BIGINT)
RETURNS SETOF public.reports
LANGUAGE plpgsql AS $$
DECLARE
  cfg public.verification_config%ROWTYPE;
  src public.reports%ROWTYPE;
  nid BIGINT;
BEGIN
  SELECT * INTO cfg FROM public.verification_config LIMIT 1;
  SELECT * INTO src FROM public.reports WHERE id = p_report_id;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN NEXT public.fn_score_report(p_report_id);

  FOR nid IN
    SELECT o.id FROM public.reports o
    WHERE o.id <> src.id
      AND o.status = 'pending'
      AND o.created_at BETWEEN src.created_at - make_interval(mins => cfg.corroboration_window_min)
                           AND src.created_at + make_interval(mins => cfg.corroboration_window_min)
      AND ST_DWithin(o.geom::geography, src.geom::geography, cfg.corroboration_radius_m)
    ORDER BY o.id
  LOOP
    RETURN NEXT public.fn_score_report(nid);
  END LOOP;
END $$;

-- ───────────── trust score feedback ─────────────
-- Fires when an ADMIN reviews a report (reviewed_by set). Auto-verifications don't count.
CREATE OR REPLACE FUNCTION public.fn_update_trust() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cfg public.verification_config%ROWTYPE;
  dv  INTEGER := 0;
  dr  INTEGER := 0;
BEGIN
  -- Only act on a manual decision: an admin is set AND (status changed OR first manual review,
  -- e.g. an admin confirming a report that was auto-verified).
  IF NEW.user_id IS NULL OR NEW.reviewed_by IS NULL
     OR (NEW.status = OLD.status AND OLD.reviewed_by IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  -- Undo the previous manual decision, if there was one (admin changed their mind)
  IF OLD.reviewed_by IS NOT NULL THEN
    IF OLD.status = 'verified' THEN dv := dv - 1; END IF;
    IF OLD.status = 'rejected' THEN dr := dr - 1; END IF;
  END IF;
  IF NEW.status = 'verified' THEN dv := dv + 1; END IF;
  IF NEW.status = 'rejected' THEN dr := dr + 1; END IF;

  SELECT * INTO cfg FROM public.verification_config LIMIT 1;

  UPDATE public.users u SET
    verified_count = GREATEST(0, u.verified_count + dv),
    rejected_count = GREATEST(0, u.rejected_count + dr),
    trust_score = ROUND(
      (GREATEST(0, u.verified_count + dv) + cfg.trust_prior_alpha)
      / (GREATEST(0, u.verified_count + dv) + GREATEST(0, u.rejected_count + dr)
         + cfg.trust_prior_alpha + cfg.trust_prior_beta), 3)
  WHERE u.id = NEW.user_id;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reports_trust ON public.reports;
CREATE TRIGGER trg_reports_trust AFTER UPDATE OF status, reviewed_by ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.fn_update_trust();

-- ───────────── live clusters ─────────────
-- DBSCAN over recent non-rejected reports, in UTM 38N metres (covers central KSA;
-- distortion elsewhere in the Kingdom is small enough for ~1 km clustering).
CREATE OR REPLACE FUNCTION public.fn_active_clusters(p_window_min INTEGER DEFAULT NULL)
RETURNS TABLE (
  cluster_key     TEXT,
  report_count    INTEGER,
  reporter_count  INTEGER,
  max_intensity   SMALLINT,
  avg_confidence  NUMERIC,
  valley_name_ar  TEXT,
  first_seen      TIMESTAMPTZ,
  last_seen       TIMESTAMPTZ,
  lng             DOUBLE PRECISION,
  lat             DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
  WITH cfg AS (SELECT * FROM public.verification_config LIMIT 1),
  recent AS (
    SELECT r.*,
           ST_ClusterDBSCAN(ST_Transform(r.geom, 32638), eps => cfg.corroboration_radius_m, minpoints => 2)
             OVER () AS cid
    FROM public.reports r, cfg
    WHERE r.status <> 'rejected'
      AND r.created_at >= now() - make_interval(mins => COALESCE(p_window_min, cfg.corroboration_window_min))
  )
  SELECT
    -- stable-ish key: the oldest report id in the cluster
    'c' || MIN(id)                                                  AS cluster_key,
    COUNT(*)::INT                                                   AS report_count,
    COUNT(DISTINCT COALESCE(user_id::text, 'anon-' || id))::INT     AS reporter_count,
    MAX(intensity)                                                  AS max_intensity,
    ROUND(AVG(confidence_score), 1)                                 AS avg_confidence,
    (SELECT v.name_ar FROM public.valleys v
      WHERE v.id = mode() WITHIN GROUP (ORDER BY recent.valley_id)) AS valley_name_ar,
    MIN(created_at), MAX(created_at),
    ST_X(ST_Centroid(ST_Collect(geom))), ST_Y(ST_Centroid(ST_Collect(geom)))
  FROM recent
  WHERE cid IS NOT NULL
  GROUP BY cid
  ORDER BY COUNT(*) DESC;
$$;
