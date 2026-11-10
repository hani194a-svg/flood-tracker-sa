// Creates an admin user, or promotes an existing one.
// Usage: npm run create-admin -- admin@example.com 'StrongPassword123'
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('usage: npm run create-admin -- <email> <password (≥ 8 chars)>');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 10);
await pool.query(
  `INSERT INTO public.users (email, password_hash, role) VALUES ($1, $2, 'admin')
   ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash`,
  [email.toLowerCase(), hash],
);
console.log(`admin ready: ${email}`);
await pool.end();
