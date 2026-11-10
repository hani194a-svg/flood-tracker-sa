import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { pool, startServer } from './helpers.js';

let srv, ids;
const api = () => request(srv.url);

/** Tiny synthetic region near Jeddah: reach A (10 km²) drains into reach B (50 km², built-up zone). */
async function seedRegion() {
  await pool.query(`DELETE FROM regions WHERE slug = 'test-region'`);
  const q = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const rg = await q(`INSERT INTO regions (slug, name_ar, bbox) VALUES ('test-region', 'اختبار', ST_MakeEnvelope(39.0, 21.3, 39.4, 21.7, 4326)) RETURNING id`);
  const rp = await q(`INSERT INTO rain_points (region_id, local_id, geom) VALUES ($1, 0, ST_SetSRID(ST_MakePoint(39.2, 21.5), 4326)) RETURNING id`, [rg.id]);
  const b = await q(`INSERT INTO streams (region_id, local_id, geom, upstream_km2, local_km2, tc_h, cn_up, zone_km2, zone_built_km2)
                     VALUES ($1, 1, ST_GeomFromText('LINESTRING(39.22 21.50, 39.18 21.49)', 4326), 50, 40, 2.5, 86, 1.2, 0.3) RETURNING id`, [rg.id]);
  const a = await q(`INSERT INTO streams (region_id, local_id, downstream_id, geom, upstream_km2, local_km2, tc_h, cn_up)
                     VALUES ($1, 0, $2, ST_GeomFromText('LINESTRING(39.25 21.52, 39.22 21.50)', 4326), 10, 10, 1.0, 88) RETURNING id`, [rg.id, b.id]);
  await pool.query(`INSERT INTO stream_rain_weights VALUES ($1, $3, 10), ($2, $3, 50)`, [a.id, b.id, rp.id]);
  const run = await q(`INSERT INTO forecast_runs (region_id, kind, source, start_time, end_time, max_level)
                       VALUES ($1, 'forecast', 'test', date_trunc('hour', now()) - interval '1 hour', date_trunc('hour', now()) + interval '48 hours', 4)
                       RETURNING id`, [rg.id]);
  await pool.query(`INSERT INTO forecast_rain SELECT $1, $2, date_trunc('hour', now()) + make_interval(hours => h), CASE WHEN h IN (0, 1) THEN 20 ELSE 0 END
                    FROM generate_series(0, 5) h`, [run.id, rp.id]);
  await pool.query(`INSERT INTO stream_forecasts VALUES
                      ($1, $2, date_trunc('hour', now()) + interval '1 hour', 40, 12, 8, 2),
                      ($1, $3, date_trunc('hour', now()) + interval '2 hours', 40, 20, 150, 4)`, [run.id, a.id, b.id]);
  await pool.query(`INSERT INTO stream_forecast_summary VALUES
                      ($1, $2, 2, 8, 12, date_trunc('hour', now()) + interval '1 hour', NULL),
                      ($1, $3, 4, 150, 20, date_trunc('hour', now()) + interval '2 hours', date_trunc('hour', now()) + interval '2 hours')`,
                   [run.id, a.id, b.id]);
  return { region: rg.id, a: a.id, b: b.id, run: run.id };
}

before(async () => { srv = await startServer(); ids = await seedRegion(); });
after(async () => {
  await pool.query(`DELETE FROM reports WHERE ST_Intersects(geom, ST_MakeEnvelope(39.0, 21.3, 39.4, 21.7, 4326))`);
  await pool.query(`DELETE FROM regions WHERE slug = 'test-region'`);
  await srv.close();
  await pool.end();
});

test('latest run, levels and alerts', async () => {
  const run = await api().get('/api/forecast/runs/latest');
  assert.equal(run.status, 200);
  assert.equal(run.body.id, ids.run);

  const lv = await api().get('/api/forecast/runs/latest/levels');
  assert.equal(lv.body.levels[ids.b][0][1], 4);
  assert.equal(lv.body.levels[ids.a][0][1], 2);

  const al = await api().get('/api/forecast/runs/latest/alerts');
  assert.deepEqual(al.body.alerts.map((a) => a.stream_id), [ids.b]);
  // A (level 2) drains into B (level 4): one alert per drainage line, so A is folded into B
  const al2 = await api().get('/api/forecast/runs/latest/alerts?minLevel=2');
  assert.deepEqual(al2.body.alerts.map((a) => a.stream_id), [ids.b]);

  assert.equal((await api().get('/api/forecast/runs/abc')).status, 400);
  assert.equal((await api().get('/api/forecast/runs/999999')).status, 404);
});

test('regions list and region-scoped latest run', async () => {
  const regions = await api().get('/api/forecast/regions');
  const r = regions.body.find((x) => x.slug === 'test-region');
  assert.equal(r.reaches, 2);
  assert.equal(r.latest.id, ids.run);
  assert.deepEqual(r.bbox.map(Number), [39.0, 21.3, 39.4, 21.7]);
  assert.equal((await api().get('/api/forecast/runs/latest?region=test-region')).body.id, ids.run);
  assert.equal((await api().get('/api/forecast/runs/latest?region=nowhere')).status, 404);
  assert.equal((await api().get('/api/forecast/runs?region=test-region')).body.length, 1);
});

test('static channel geometry is cached with an ETag', async () => {
  const first = await api().get('/api/forecast/regions/test-region/streams.geojson');
  assert.equal(first.status, 200);
  const fc = JSON.parse(first.text);
  assert.equal(fc.features.length, 2);
  const again = await api().get('/api/forecast/regions/test-region/streams.geojson').set('If-None-Match', first.headers.etag);
  assert.equal(again.status, 304);
  assert.equal(JSON.parse((await api().get('/api/forecast/regions/test-region/streams.geojson?minUpstream=20')).text).features.length, 1);
});

test('reach timeline has basin rain and risk', async () => {
  const t = await api().get(`/api/forecast/runs/${ids.run}/streams/${ids.b}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.rain.filter((r) => r.mm > 0).length, 2);
  assert.equal(t.body.risk[0].level, 4);
});

test('a report beside a high-risk reach gets the forecast signal', async () => {
  const r = await api().post('/api/reports').send({ title: 'جريان قوي', intensity: 4, latitude: 21.495, longitude: 39.20 });
  assert.equal(r.status, 201);
  const { rows: [row] } = await pool.query('SELECT forecast_level, confidence_score FROM reports WHERE id = $1', [r.body.id]);
  assert.equal(row.forecast_level, 4);
  // valley 30·1 + corroboration 0 + anonymous trust 15·0.3 + forecast 25·1
  assert.equal(row.confidence_score, 59.5);
});

test('NOTIFY forecast_ready reaches every socket client', async (t) => {
  const sock = ioClient(srv.url, { transports: ['websocket'] });
  t.after(() => sock.close());
  await new Promise((r) => sock.on('connect', r));
  const got = new Promise((resolve) => sock.on('forecast:alert', resolve));
  await pool.query(`SELECT pg_notify('forecast_ready', $1)`, [JSON.stringify({ run_id: ids.run, kind: 'forecast', max_level: 4 })]);
  const msg = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
  assert.equal(msg.run_id, ids.run);
});
