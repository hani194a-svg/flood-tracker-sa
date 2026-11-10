// Applies db/migrations/*.sql in order, once each (tracked in schema_migrations).
// Usage: npm run migrate          (migrations only)
//        npm run seed             (migrations + sample valleys)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

// repo layout: backend/scripts → ../../db ; Docker image: /app/scripts → /db
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');

async function run() {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await pool.query('SELECT name FROM public.schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  const files = (await fs.readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await fs.readFile(path.join(root, 'migrations', f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${f}: ${e.message}`);
    } finally {
      client.release();
    }
  }

  if (process.argv.includes('--seed')) {
    await pool.query(await fs.readFile(path.join(root, 'seed', 'valleys_sample.sql'), 'utf8'));
    console.log('seeded sample valleys');
  }
}

run()
  .then(() => pool.end())
  .catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
