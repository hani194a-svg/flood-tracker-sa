import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return { id: p.sub, role: p.role, email: p.email };
  } catch {
    return null;
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Attaches req.user when a valid token is present; never rejects. */
export function optionalAuth(req, _res, next) {
  const t = bearer(req);
  req.user = t ? verifyToken(t) : null;
  next();
}

export function requireAuth(req, res, next) {
  const t = bearer(req);
  const user = t && verifyToken(t);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  });
}
