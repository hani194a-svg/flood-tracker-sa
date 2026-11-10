// Imports Saudi wadis from OpenStreetMap into public.valleys.
//
//   npm run import:valleys                          fetch all of KSA from Overpass
//   npm run import:valleys -- --remove-sample       …and delete the 3 rough sample valleys
//   npm run import:valleys -- --bbox 46.3,24.3,47.1,25.1     only an area (minLng,minLat,maxLng,maxLat)
//   npm run import:valleys -- --save osm.json       also save the raw Overpass response
//   npm run import:valleys -- --file osm.json       import a saved response (no network)
//
// Data © OpenStreetMap contributors (ODbL).
import fs from 'node:fs/promises';
import { pool, withTransaction } from '../src/db.js';
import { buildQuery, fetchOverpass, parseOverpass, importValleys } from '../src/services/valleyImport.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  let json;
  if (opt('file')) {
    json = JSON.parse(await fs.readFile(opt('file'), 'utf8'));
  } else {
    let bbox;
    if (opt('bbox')) {
      const [minLng, minLat, maxLng, maxLat] = opt('bbox').split(',').map(Number);
      bbox = { minLng, minLat, maxLng, maxLat };
    }
    json = await fetchOverpass(buildQuery({ bbox }), { log: console.log });
    if (opt('save')) await fs.writeFile(opt('save'), JSON.stringify(json));
  }

  const rows = parseOverpass(json);
  console.log(`parsed ${rows.length} waterway segments`);
  if (!rows.length) throw new Error('no waterways found — refusing to import an empty set');

  const result = await withTransaction((db) =>
    importValleys(db, rows, { removeSample: args.includes('--remove-sample') }));
  console.log(`valleys upserted: ${result.valleys}, removed (gone upstream): ${result.removed}` +
    (result.removedSample ? `, sample rows removed: ${result.removedSample}` : ''));

  // Re-score reports from the last 7 days against the new valley geometry
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(public.fn_score_report(id))::int AS n FROM public.reports
     WHERE created_at >= now() - interval '7 days' AND status <> 'rejected'`);
  console.log(`re-scored ${n} recent reports`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
