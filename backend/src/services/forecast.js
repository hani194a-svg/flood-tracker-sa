import { query } from '../db.js';

const RUN_COLUMNS = `fr.id, rg.slug AS region, rg.name_ar AS region_name_ar, fr.kind, fr.label, fr.source,
  fr.start_time, fr.end_time, fr.max_level, fr.params, fr.created_at`;

export async function listRuns({ kind, limit = 20 } = {}) {
  const params = [];
  let where = '';
  if (kind) { params.push(kind); where = `WHERE fr.kind = $1`; }
  params.push(Math.min(Number(limit) || 20, 100));
  const { rows } = await query(
    `SELECT ${RUN_COLUMNS} FROM public.forecast_runs fr JOIN public.regions rg ON rg.id = fr.region_id
     ${where} ORDER BY fr.created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

/** `id` may be a number or 'latest' (newest live forecast). */
export async function getRun(id) {
  const { rows } = await query(
    id === 'latest'
      ? `SELECT ${RUN_COLUMNS} FROM public.forecast_runs fr JOIN public.regions rg ON rg.id = fr.region_id
         WHERE fr.kind = 'forecast' ORDER BY fr.created_at DESC LIMIT 1`
      : `SELECT ${RUN_COLUMNS} FROM public.forecast_runs fr JOIN public.regions rg ON rg.id = fr.region_id
         WHERE fr.id = $1`,
    id === 'latest' ? [] : [Number(id)]);
  return rows[0] || null;
}

// Static channel geometry changes only when terrain is reloaded → cache per region.
const geoCache = new Map();
export async function streamsGeoJSON(regionSlug, minUpstreamKm2 = 2) {
  const key = `${regionSlug}:${minUpstreamKm2}`;
  const hit = geoCache.get(key);
  const { rows: [rg] } = await query('SELECT id, loaded_at FROM public.regions WHERE slug = $1', [regionSlug]);
  if (!rg) return null;
  if (hit && hit.loadedAt === rg.loaded_at.toISOString()) return hit;

  const { rows: [{ fc }] } = await query(
    `SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
       'type', 'Feature', 'id', s.id,
       'geometry', ST_AsGeoJSON(s.geom, 5)::json,
       'properties', json_build_object('id', s.id, 'upstream_km2', s.upstream_km2, 'tc_h', s.tc_h,
          'built_km2', s.zone_built_km2, 'truncated', s.truncated, 'valley_name_ar', v.name_ar)
     ) ORDER BY s.upstream_km2), '[]'::json)) AS fc
     FROM public.streams s LEFT JOIN public.valleys v ON v.id = s.valley_id
     WHERE s.region_id = $1 AND s.upstream_km2 >= $2`, [rg.id, minUpstreamKm2]);
  const entry = { loadedAt: rg.loaded_at.toISOString(), body: JSON.stringify(fc), etag: `"${rg.id}-${rg.loaded_at.getTime()}-${minUpstreamKm2}"` };
  geoCache.set(key, entry);
  return entry;
}

/** Flood-prone zones for reaches that reach `minLevel` in the run. */
export async function zonesGeoJSON(runId, minLevel = 3) {
  const { rows: [{ fc }] } = await query(
    `SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
       'type', 'Feature', 'id', z.stream_id,
       'geometry', ST_AsGeoJSON(z.geom, 5)::json,
       'properties', json_build_object('stream_id', z.stream_id, 'max_level', sm.max_level,
          'built_km2', z.built_up_km2, 'area_km2', z.area_km2)
     )), '[]'::json)) AS fc
     FROM public.stream_forecast_summary sm JOIN public.flood_zones z ON z.stream_id = sm.stream_id
     WHERE sm.run_id = $1 AND sm.max_level >= $2`, [runId, minLevel]);
  return fc;
}

/**
 * Compact levels for animating the map: hourly time axis + per-reach sparse series.
 * levels[streamId] = [[hourIndex, level, peak_m3s], …] (absent hours = level 1)
 */
export async function runLevels(run) {
  const start = new Date(run.start_time).getTime();
  const end = new Date(run.end_time).getTime();
  const { rows } = await query(
    `SELECT stream_id, valid_time, level, peak_m3s FROM public.stream_forecasts WHERE run_id = $1 ORDER BY valid_time`,
    [run.id]);
  const hours = Math.round((end - start) / 3.6e6) + 24;   // peaks can land after the last rain hour
  const levels = {};
  for (const r of rows) {
    const h = Math.round((r.valid_time.getTime() - start) / 3.6e6);
    (levels[r.stream_id] ||= []).push([h, r.level, Math.round(r.peak_m3s * 10) / 10]);
  }
  return { start: run.start_time, hours, levels };
}

/** Hourly basin-average rain + risk for one reach (for the timeline chart). */
export async function streamTimeline(runId, streamId) {
  const { rows: [stream] } = await query(
    `SELECT s.id, s.upstream_km2, s.tc_h, s.cn_up, s.zone_built_km2, s.truncated, v.name_ar AS valley_name_ar,
            ST_X(ST_Centroid(s.geom)) AS lng, ST_Y(ST_Centroid(s.geom)) AS lat
     FROM public.streams s LEFT JOIN public.valleys v ON v.id = s.valley_id WHERE s.id = $1`, [streamId]);
  if (!stream) return null;
  const { rows: rain } = await query(
    `SELECT fr.valid_time, SUM(fr.precip_mm * w.area_km2) / NULLIF(SUM(w.area_km2), 0) AS rain_mm
     FROM public.stream_rain_weights w
     JOIN public.forecast_rain fr ON fr.rain_point_id = w.rain_point_id AND fr.run_id = $1
     WHERE w.stream_id = $2 GROUP BY fr.valid_time ORDER BY fr.valid_time`, [runId, streamId]);
  const { rows: risk } = await query(
    `SELECT valid_time, level, peak_m3s, runoff_mm, rain_mm FROM public.stream_forecasts
     WHERE run_id = $1 AND stream_id = $2 ORDER BY valid_time`, [runId, streamId]);
  return {
    stream,
    rain: rain.map((r) => ({ t: r.valid_time, mm: Math.round(r.rain_mm * 100) / 100 })),
    risk: risk.map((r) => ({ t: r.valid_time, level: r.level, peak_m3s: Math.round(r.peak_m3s * 10) / 10,
                             runoff_mm: Math.round(r.runoff_mm * 10) / 10, window_rain_mm: Math.round(r.rain_mm * 10) / 10 })),
  };
}

/** Reaches at or above `minLevel` in a run, worst first. */
export async function alerts(runId, minLevel = 4) {
  const { rows } = await query(
    `SELECT s.id AS stream_id, sm.max_level, sm.max_peak_m3s, sm.max_runoff_mm, sm.time_of_max, sm.first_level3_at,
            s.upstream_km2, s.zone_built_km2, s.truncated, v.name_ar AS valley_name_ar,
            ST_X(ST_PointN(s.geom, ST_NPoints(s.geom))) AS lng, ST_Y(ST_PointN(s.geom, ST_NPoints(s.geom))) AS lat
     FROM public.stream_forecast_summary sm
     JOIN public.streams s ON s.id = sm.stream_id
     LEFT JOIN public.valleys v ON v.id = s.valley_id
     WHERE sm.run_id = $1 AND sm.max_level >= $2
       -- one row per drainage line: skip reaches whose downstream reach is also listed
       AND NOT EXISTS (SELECT 1 FROM public.stream_forecast_summary d
                       WHERE d.run_id = sm.run_id AND d.stream_id = s.downstream_id AND d.max_level >= sm.max_level)
     ORDER BY sm.max_level DESC, sm.max_peak_m3s DESC
     LIMIT 50`, [runId, minLevel]);
  return rows;
}
