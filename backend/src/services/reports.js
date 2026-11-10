import { query, withTransaction } from '../db.js';
import { config } from '../config.js';

// Columns returned to admins. lng/lat are derived from geom.
const ADMIN_COLUMNS = `
  r.id, r.user_id, r.title, r.description, r.intensity, r.status,
  ST_X(r.geom) AS longitude, ST_Y(r.geom) AS latitude,
  r.valley_id, v.name_ar AS valley_name_ar, r.valley_distance_m,
  r.corroboration_count, r.confidence_score, r.auto_verified,
  r.reviewed_by, r.reviewed_at, r.created_at, r.updated_at,
  u.email AS reporter_email, u.trust_score AS reporter_trust`;

const ADMIN_FROM = `
  FROM public.reports r
  LEFT JOIN public.valleys v ON v.id = r.valley_id
  LEFT JOIN public.users   u ON u.id = r.user_id`;

/** Strip fields the public must never see. */
export function toPublic(r) {
  return {
    id: r.id,
    title: r.title,
    intensity: r.intensity,
    status: r.status,
    longitude: r.longitude,
    latitude: r.latitude,
    valley_name_ar: r.valley_name_ar ?? null,
    confidence_score: r.confidence_score,
    created_at: r.created_at,
  };
}

async function fetchByIds(ids, db = { query }) {
  if (!ids.length) return [];
  const { rows } = await db.query(`SELECT ${ADMIN_COLUMNS} ${ADMIN_FROM} WHERE r.id = ANY($1) ORDER BY r.id`, [ids]);
  return rows;
}

export class DuplicateReportError extends Error {
  constructor(existingId) {
    super('duplicate_report');
    this.status = 409;
    this.existingId = existingId;
  }
}

/**
 * Inserts a report, runs the verification engine, and returns
 * { report, affected } where `affected` are other reports whose score changed.
 */
export async function createReport(input, userId) {
  return withTransaction(async (db) => {
    if (userId) {
      const dup = await db.query(
        `SELECT id FROM public.reports
         WHERE user_id = $1
           AND created_at >= now() - make_interval(mins => $2)
           AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
         LIMIT 1`,
        [userId, config.duplicateWindowMin, input.longitude, input.latitude, config.duplicateRadiusM],
      );
      if (dup.rows[0]) throw new DuplicateReportError(dup.rows[0].id);
    }

    const { rows: [{ id }] } = await db.query(
      `INSERT INTO public.reports (user_id, title, description, intensity, geom)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
       RETURNING id`,
      [userId, input.title, input.description, input.intensity, input.longitude, input.latitude],
    );

    const { rows: scored } = await db.query('SELECT id FROM public.fn_process_report($1)', [id]);
    const all = await fetchByIds(scored.map((r) => r.id), db);
    return {
      report: all.find((r) => r.id === id),
      affected: all.filter((r) => r.id !== id),
    };
  });
}

export async function getReport(id) {
  const [r] = await fetchByIds([id]);
  return r || null;
}

export async function listReports({ status, search, sort = 'newest', limit = 100, offset = 0 }) {
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(r.title ILIKE $${params.length} OR r.description ILIKE $${params.length} OR v.name_ar ILIKE $${params.length})`);
  }
  const orderBy = sort === 'confidence'
    ? 'r.confidence_score DESC NULLS LAST, r.created_at DESC'
    : 'r.created_at DESC';
  params.push(Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0));

  const { rows } = await query(
    `SELECT ${ADMIN_COLUMNS}, COUNT(*) OVER() AS total_count ${ADMIN_FROM}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total: rows[0]?.total_count ?? 0, reports: rows.map(({ total_count, ...r }) => r) };
}

/** Reports inside the map viewport, using the GIST index via && + ST_MakeEnvelope. */
export async function reportsInViewport(bbox, { statuses, sinceHours = 48, limit = 2000 }) {
  const { rows } = await query(
    `SELECT ${ADMIN_COLUMNS} ${ADMIN_FROM}
     WHERE r.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
       AND r.status = ANY($5)
       AND r.created_at >= now() - make_interval(hours => $6)
     ORDER BY r.created_at DESC
     LIMIT $7`,
    [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat, statuses, sinceHours, limit],
  );
  return rows;
}

export async function setStatus(id, status, adminId) {
  const { rowCount } = await query(
    `UPDATE public.reports
     SET status = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1`,
    [id, status, adminId],
  );
  return rowCount ? getReport(id) : null;
}

export async function activeClusters(windowMin) {
  const { rows } = await query('SELECT * FROM public.fn_active_clusters($1)', [windowMin ?? null]);
  return rows;
}

export async function getVerificationConfig() {
  const { rows } = await query('SELECT * FROM public.verification_config LIMIT 1');
  return rows[0];
}
