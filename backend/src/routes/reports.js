import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { optionalAuth, requireAdmin } from '../middleware/auth.js';
import { validateReport, parseBbox, STATUSES, ValidationError } from '../validation.js';
import * as reports from '../services/reports.js';

/**
 * @param {object} deps
 * @param {import('../realtime.js').Realtime} deps.realtime
 */
export default function reportsRouter({ realtime }) {
  const router = Router();

  const submitLimiter = rateLimit({
    windowMs: config.reportRateWindowMs,
    limit: config.reportRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_reports' },
  });

  // Submit a report (anonymous or signed in). Runs the verification engine inline.
  router.post('/', submitLimiter, optionalAuth, async (req, res, next) => {
    try {
      const input = validateReport(req.body);
      const { report, affected } = await reports.createReport(input, req.user?.id ?? null);
      realtime.reportCreated(report);
      for (const r of affected) realtime.reportUpdated(r);
      realtime.checkClusters();
      res.status(201).json(req.user?.role === 'admin' ? report : reports.toPublic(report));
    } catch (e) {
      if (e instanceof reports.DuplicateReportError) {
        return res.status(409).json({ error: 'duplicate_report', existingId: e.existingId });
      }
      next(e);
    }
  });

  // Reports inside the current map viewport.
  // Public: verified only. Admin: may request any statuses via ?status=pending,verified
  router.get('/viewport', optionalAuth, async (req, res, next) => {
    try {
      const bbox = parseBbox(req.query.bbox);
      const isAdmin = req.user?.role === 'admin';
      let statuses = ['verified'];
      if (isAdmin && req.query.status) {
        statuses = String(req.query.status).split(',').filter((s) => STATUSES.includes(s));
        if (!statuses.length) throw new ValidationError({ status: 'unknown status' });
      }
      const sinceHours = Math.min(Math.max(Number(req.query.sinceHours) || 48, 1), 24 * 30);
      const rows = await reports.reportsInViewport(bbox, { statuses, sinceHours });
      res.json(isAdmin ? rows : rows.map(reports.toPublic));
    } catch (e) { next(e); }
  });

  // ───── admin ─────
  router.get('/', requireAdmin, async (req, res, next) => {
    try {
      const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
      const search = req.query.search ? String(req.query.search).slice(0, 100) : undefined;
      const sort = req.query.sort === 'confidence' ? 'confidence' : 'newest';
      res.json(await reports.listReports({ status, search, sort, limit: req.query.limit, offset: req.query.offset }));
    } catch (e) { next(e); }
  });

  router.get('/clusters', requireAdmin, async (req, res, next) => {
    try {
      const windowMin = req.query.windowMin ? Math.min(Number(req.query.windowMin), 24 * 60) : undefined;
      res.json(await reports.activeClusters(windowMin));
    } catch (e) { next(e); }
  });

  router.get('/:id', requireAdmin, async (req, res, next) => {
    try {
      const r = await reports.getReport(Number(req.params.id));
      if (!r) return res.status(404).json({ error: 'not_found' });
      res.json(r);
    } catch (e) { next(e); }
  });

  router.patch('/:id/status', requireAdmin, async (req, res, next) => {
    try {
      const status = req.body?.status;
      if (!['verified', 'rejected'].includes(status)) {
        throw new ValidationError({ status: 'status must be verified or rejected' });
      }
      const r = await reports.setStatus(Number(req.params.id), status, req.user.id);
      if (!r) return res.status(404).json({ error: 'not_found' });
      realtime.reportUpdated(r);
      res.json(r);
    } catch (e) { next(e); }
  });

  return router;
}
