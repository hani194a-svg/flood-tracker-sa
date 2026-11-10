import { Router } from 'express';
import * as fc from '../services/forecast.js';

// Flood forecasts are public-safety information: no auth on reads.
export default function forecastRouter() {
  const router = Router();

  router.get('/regions', async (_req, res, next) => {
    try { res.json(await fc.listRegions()); } catch (e) { next(e); }
  });

  router.get('/runs', async (req, res, next) => {
    try {
      const kind = ['forecast', 'archive', 'scenario'].includes(req.query.kind) ? req.query.kind : undefined;
      const region = typeof req.query.region === 'string' ? req.query.region.slice(0, 40) : undefined;
      res.json(await fc.listRuns({ kind, region, limit: req.query.limit }));
    } catch (e) { next(e); }
  });

  router.get('/regions/:slug/streams.geojson', async (req, res, next) => {
    try {
      const minUp = Math.max(Number(req.query.minUpstream) || 2, 1);
      const entry = await fc.streamsGeoJSON(req.params.slug, minUp);
      if (!entry) return res.status(404).json({ error: 'not_found' });
      res.set('ETag', entry.etag).set('Cache-Control', 'public, max-age=300');
      if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
      res.type('application/geo+json').send(entry.body);
    } catch (e) { next(e); }
  });

  // Resolve :run ('latest' or numeric id) once for the run-scoped routes below
  router.param('run', async (req, res, next, id) => {
    try {
      if (id !== 'latest' && !/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid_run' });
      const region = typeof req.query.region === 'string' ? req.query.region.slice(0, 40) : undefined;
      const run = await fc.getRun(id, region);
      if (!run) return res.status(404).json({ error: 'no_forecast' });
      req.run = run;
      next();
    } catch (e) { next(e); }
  });

  router.get('/runs/:run', (req, res) => res.json(req.run));

  router.get('/runs/:run/levels', async (req, res, next) => {
    try { res.json({ run: req.run, ...(await fc.runLevels(req.run)) }); } catch (e) { next(e); }
  });

  router.get('/runs/:run/alerts', async (req, res, next) => {
    try {
      const minLevel = Math.min(Math.max(Number(req.query.minLevel) || 4, 2), 5);
      res.json({ run: req.run, alerts: await fc.alerts(req.run.id, minLevel) });
    } catch (e) { next(e); }
  });

  router.get('/runs/:run/zones.geojson', async (req, res, next) => {
    try {
      const minLevel = Math.min(Math.max(Number(req.query.minLevel) || 3, 2), 5);
      res.type('application/geo+json').json(await fc.zonesGeoJSON(req.run.id, minLevel));
    } catch (e) { next(e); }
  });

  router.get('/runs/:run/streams/:streamId', async (req, res, next) => {
    try {
      const t = await fc.streamTimeline(req.run.id, Number(req.params.streamId));
      if (!t) return res.status(404).json({ error: 'not_found' });
      res.json({ run: req.run, ...t });
    } catch (e) { next(e); }
  });

  return router;
}
