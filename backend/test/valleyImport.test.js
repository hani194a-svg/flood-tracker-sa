import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pool } from './helpers.js';
import { parseOverpass, importValleys, buildQuery } from '../src/services/valleyImport.js';

after(() => pool.end());

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/overpass-sample.json', import.meta.url), 'utf8'));

/** Runs fn inside a transaction that is always rolled back, so the shared test DB is untouched. */
async function inRollback(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

test('parseOverpass keeps lines, splits Arabic/English names, drops nodes and 1-point ways', () => {
  const rows = parseOverpass(fixture);
  assert.deepEqual(rows.map((r) => r.osm_id), [1001, 1002, 1003, 1004, 1005]);
  assert.equal(rows[0].name_ar, 'وادي الاختبار');
  assert.equal(rows[0].name_en, 'Wadi Test');
  assert.equal(rows[3].name_ar, null);
  assert.equal(rows[4].name_ar, null);
  assert.equal(rows[4].name_en, 'Wadi English Only');
  assert.match(rows[0].wkt, /^LINESTRING\(46\.1 24\.1,46\.11 24\.11\)$/);
});

test('buildQuery targets Saudi Arabia, or a bbox when given', () => {
  assert.match(buildQuery(), /"ISO3166-1"="SA"/);
  const q = buildQuery({ bbox: { minLng: 46, minLat: 24, maxLng: 47, maxLat: 25 } });
  assert.match(q, /\(24,46,25,47\)/);
  assert.doesNotMatch(q, /area\.sa/);
});

test('importValleys merges touching same-name ways, keeps distant namesakes apart, upserts in place', () =>
  inRollback(async (db) => {
    await db.query('SAVEPOINT s');
    const rows = parseOverpass(fixture);
    const first = await importValleys(db, rows, { removeSample: true });
    assert.equal(first.valleys, 4); // [1001+1002], [1003], [1004], [1005]
    assert.equal(first.removedSample, 3);

    const { rows: v } = await db.query(
      `SELECT source_key, name_ar, osm_ids, ST_GeometryType(geom) AS t FROM valleys WHERE source='osm' ORDER BY source_key`);
    assert.deepEqual(v.map((r) => r.source_key), ['osm:way:1001', 'osm:way:1003', 'osm:way:1004', 'osm:way:1005']);
    assert.deepEqual(v[0].osm_ids.map(Number), [1001, 1002]);
    assert.ok(v.every((r) => r.t === 'ST_MultiLineString'));

    // A report on the merged wadi now resolves to it
    const { rows: [rep] } = await db.query(
      `INSERT INTO reports (title, intensity, geom) VALUES ('test', 3, ST_SetSRID(ST_MakePoint(46.115, 24.115), 4326)) RETURNING id`);
    const { rows: [scored] } = await db.query('SELECT valley_id FROM fn_score_report($1)', [rep.id]);
    const { rows: [ids] } = await db.query(`SELECT id FROM valleys WHERE source_key='osm:way:1001'`);
    assert.equal(scored.valley_id, ids.id);

    // Re-import in a later transaction without way 1005: same ids kept, 1005 removed,
    // and the report's valley link survives.
    await db.query('RELEASE SAVEPOINT s');
    await db.query('COMMIT');
    await db.query('BEGIN');
    const second = await importValleys(db, rows.filter((r) => r.osm_id !== 1005));
    assert.equal(second.valleys, 3);
    assert.equal(second.removed, 1);
    const { rows: [after] } = await db.query(`SELECT id FROM valleys WHERE source_key='osm:way:1001'`);
    assert.equal(after.id, ids.id);
    const { rows: [link] } = await db.query('SELECT valley_id FROM reports WHERE id=$1', [rep.id]);
    assert.equal(link.valley_id, ids.id);

    // cleanup what the first COMMIT persisted
    await db.query(`DELETE FROM reports WHERE id = $1`, [rep.id]);
    await db.query(`DELETE FROM valleys WHERE source = 'osm'`);
    await db.query('COMMIT');
    await db.query(await fs.readFile(new URL('../../db/seed/valleys_sample.sql', import.meta.url), 'utf8'));
    await db.query('BEGIN'); // so inRollback's ROLLBACK has a transaction to end
  }));
