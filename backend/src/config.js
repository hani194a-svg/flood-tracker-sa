import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL'),
  // Supabase requires TLS; local Postgres usually doesn't.
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),
  // Report submissions allowed per IP per window
  reportRateLimit: Number(process.env.REPORT_RATE_LIMIT || 5),
  reportRateWindowMs: Number(process.env.REPORT_RATE_WINDOW_MS || 10 * 60 * 1000),
  // Same user re-reporting within this radius/time is treated as a duplicate
  duplicateRadiusM: Number(process.env.DUPLICATE_RADIUS_M || 200),
  duplicateWindowMin: Number(process.env.DUPLICATE_WINDOW_MIN || 10),
};

// Rough bounding box of Saudi Arabia (with a small margin)
export const KSA_BBOX = { minLng: 34.4, minLat: 16.2, maxLng: 55.8, maxLat: 32.3 };
