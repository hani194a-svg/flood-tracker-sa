// Test bootstrap: point at a disposable database BEFORE importing app modules.
// TEST_DATABASE_URL must point at a database where `npm run seed` has been run.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/floods_test';
process.env.JWT_SECRET = 'test-secret';
process.env.REPORT_RATE_LIMIT = '1000';

import http from 'node:http';
import bcrypt from 'bcryptjs';

const { createApp } = await import('../src/app.js');
const { Realtime } = await import('../src/realtime.js');
const { pool } = await import('../src/db.js');
const { signToken } = await import('../src/middleware/auth.js');

export { pool, signToken };

export async function resetDb() {
  await pool.query('TRUNCATE public.reports, public.users RESTART IDENTITY CASCADE');
}

export async function makeUser(email, role = 'reporter') {
  const hash = await bcrypt.hash('password123', 4);
  const { rows } = await pool.query(
    'INSERT INTO public.users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
    [email, hash, role],
  );
  return { ...rows[0], token: signToken(rows[0]) };
}

/** Starts the real HTTP + Socket.io server on a random port. */
export async function startServer() {
  const server = http.createServer();
  const realtime = Realtime.attach(server, '*');
  server.on('request', createApp({ realtime }));
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    server,
    realtime,
    close: () => new Promise((r) => { realtime.close(); server.close(r); }),
  };
}

// Points along the sample Wadi Hanifah seed geometry (Riyadh)
export const HANIFAH = { latitude: 24.68, longitude: 46.68 };
export const DESERT = { latitude: 23.0, longitude: 45.0 };
export const jitter = (p, d) => ({ latitude: p.latitude + d, longitude: p.longitude + d });
