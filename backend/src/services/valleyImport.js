// Imports valley (wadi) geometries from OpenStreetMap via the Overpass API.
//
// OSM stores a wadi as many short `way`s. We:
//   1. load every way into a temp table,
//   2. group ways that share a name AND touch/are close (≤ ~1 km gap) using
//      ST_ClusterDBSCAN partitioned by name — so two different "وادي الحمض"
//      hundreds of km apart stay separate valleys,
//   3. upsert each group into public.valleys keyed by its smallest way id, so
//      re-imports update rows in place and reports keep their valley_id links,
//   4. delete OSM valleys that no longer exist upstream.
//
// Data © OpenStreetMap contributors, ODbL — attribution is required on the map.

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * waterway=wadi is the traditional tag; newer mapping uses river/stream + intermittent=yes.
 * Unnamed perennial streams are skipped (noise); unnamed wadis/intermittent channels are kept.
 */
export function buildQuery({ bbox } = {}) {
  const area = bbox
    ? `(${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng})`
    : '(area.sa)';
  return `[out:json][timeout:600][maxsize:1073741824];
${bbox ? '' : 'area["ISO3166-1"="SA"][admin_level=2]->.sa;'}
(
  way["waterway"="wadi"]${area};
  way["waterway"~"^(river|stream)$"]["intermittent"="yes"]${area};
  way["waterway"~"^(river|stream)$"]["name"]${area};
);
out tags geom;`;
}

/** Overpass JSON → plain rows. Drops anything that is not a usable line. */
export function parseOverpass(json) {
  const rows = [];
  for (const el of json?.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const t = el.tags ?? {};
    const nameAr = t['name:ar'] || (/[؀-ۿ]/.test(t.name ?? '') ? t.name : null);
    const nameEn = t['name:en'] || (t.name && !/[؀-ۿ]/.test(t.name) ? t.name : null);
    rows.push({
      osm_id: el.id,
      name_ar: nameAr,
      name_en: nameEn,
      waterway: t.waterway,
      wkt: `LINESTRING(${el.geometry.map((p) => `${p.lon} ${p.lat}`).join(',')})`,
    });
  }
  return rows;
}

export async function fetchOverpass(query, { endpoints = OVERPASS_ENDPOINTS, log = () => {} } = {}) {
  let lastErr;
  for (const url of endpoints) {
    try {
      log(`querying ${url} …`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'flood-tracker-sa/0.1' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      log(`  failed: ${e.message}`);
    }
  }
  throw new Error(`all Overpass endpoints failed (last: ${lastErr?.message})`);
}

/**
 * Upserts parsed rows into public.valleys. Run inside a transaction (pass a client).
 * @returns {{ ways: number, valleys: number, removed: number, removedSample: number }}
 */
export async function importValleys(db, rows, { mergeGapM = 1000, removeSample = false } = {}) {
  await db.query(`CREATE TEMP TABLE osm_ways (
      osm_id BIGINT PRIMARY KEY, name_ar TEXT, name_en TEXT, waterway TEXT,
      geom GEOMETRY(LineString, 4326)) ON COMMIT DROP`);

  // Batched so a country-sized import doesn't build one giant statement
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.query(
      `INSERT INTO osm_ways (osm_id, name_ar, name_en, waterway, geom)
       SELECT t.osm_id, t.name_ar, t.name_en, t.waterway, ST_GeomFromText(t.wkt, 4326)
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS t(osm_id, name_ar, name_en, waterway, wkt)
       ON CONFLICT (osm_id) DO NOTHING`,
      [
        chunk.map((r) => r.osm_id), chunk.map((r) => r.name_ar), chunk.map((r) => r.name_en),
        chunk.map((r) => r.waterway), chunk.map((r) => r.wkt),
      ],
    );
  }
  await db.query('DELETE FROM osm_ways WHERE NOT ST_IsValid(geom) OR ST_Length(geom) = 0');

  const { rows: [{ valleys }] } = await db.query(
    `WITH clustered AS (
       SELECT w.*,
              -- unnamed ways are never merged with each other
              CASE WHEN w.name_ar IS NULL AND w.name_en IS NULL THEN w.osm_id::text
                   ELSE COALESCE(w.name_ar, '') || '|' || COALESCE(w.name_en, '') || '|' ||
                        ST_ClusterDBSCAN(ST_Transform(w.geom, 32638), eps => $1, minpoints => 1)
                          OVER (PARTITION BY w.name_ar, w.name_en)
              END AS grp
       FROM osm_ways w
     ),
     grouped AS (
       SELECT 'osm:way:' || MIN(osm_id)                         AS source_key,
              MAX(name_ar)                                      AS name_ar,
              MAX(name_en)                                      AS name_en,
              mode() WITHIN GROUP (ORDER BY waterway)           AS waterway,
              array_agg(osm_id ORDER BY osm_id)                 AS osm_ids,
              ST_Multi(ST_LineMerge(ST_Collect(geom)))          AS geom
       FROM clustered GROUP BY grp
     ),
     up AS (
       INSERT INTO public.valleys (source, source_key, name_ar, name_en, waterway, osm_ids, geom, updated_at)
       SELECT 'osm', source_key, name_ar, name_en, waterway, osm_ids,
              ST_CollectionExtract(geom, 2)::geometry(MultiLineString, 4326), now()
       FROM grouped
       ON CONFLICT (source_key) DO UPDATE SET
         name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en, waterway = EXCLUDED.waterway,
         osm_ids = EXCLUDED.osm_ids, geom = EXCLUDED.geom, updated_at = now()
       RETURNING source_key
     )
     SELECT COUNT(*)::int AS valleys FROM up`,
    [mergeGapM],
  );

  // Every row upserted above has updated_at = now() (= transaction start), so any
  // OSM row with an older timestamp was not in this import: gone upstream or re-keyed.
  const { rowCount: removed } = await db.query(
    `DELETE FROM public.valleys WHERE source = 'osm' AND updated_at < now()`,
  );

  let removedSample = 0;
  if (removeSample) {
    ({ rowCount: removedSample } = await db.query(`DELETE FROM public.valleys WHERE source = 'sample'`));
  }

  return { ways: rows.length, valleys, removed, removedSample };
}
