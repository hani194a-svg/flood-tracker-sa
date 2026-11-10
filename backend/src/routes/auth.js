import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const displayName = req.body?.displayName ? String(req.body.displayName).slice(0, 80) : null;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO public.users (email, password_hash, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role, display_name, trust_score`,
      [email, hash, displayName],
    );
    if (!rows[0]) return res.status(409).json({ error: 'email_taken' });
    res.status(201).json({ token: signToken(rows[0]), user: rows[0] });
  } catch (e) { next(e); }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const { rows } = await query(
      'SELECT id, email, role, display_name, trust_score, password_hash FROM public.users WHERE email = $1',
      [email],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    delete user.password_hash;
    res.json({ token: signToken(user), user });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, email, role, display_name, trust_score, verified_count, rejected_count
       FROM public.users WHERE id = $1`,
      [req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;
