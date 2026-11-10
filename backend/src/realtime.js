import { Server } from 'socket.io';
import { verifyToken } from './middleware/auth.js';
import { toPublic } from './services/reports.js';
import { createClusterAlerter } from './services/alerts.js';

/**
 * Socket.io channels
 *   admins room  ← report:new, report:updated, cluster:alert   (full report rows)
 *   everyone     ← report:verified, report:removed             (public fields only)
 *
 * Admins authenticate with `io(url, { auth: { token } })`.
 */
export class Realtime {
  #timer = null;

  constructor(io) {
    this.io = io;
    this.checkClusters = this.#debounced(
      createClusterAlerter((cluster) => io?.to('admins').emit('cluster:alert', cluster)),
    );
  }

  static attach(httpServer, corsOrigins) {
    const io = new Server(httpServer, { cors: { origin: corsOrigins } });
    io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      socket.data.user = token ? verifyToken(token) : null;
      next();
    });
    io.on('connection', (socket) => {
      if (socket.data.user?.role === 'admin') socket.join('admins');
    });
    return new Realtime(io);
  }

  reportCreated(r) {
    this.io?.to('admins').emit('report:new', r);
    if (r.status === 'verified') this.io?.emit('report:verified', toPublic(r));
  }

  reportUpdated(r) {
    this.io?.to('admins').emit('report:updated', r);
    if (r.status === 'verified') this.io?.emit('report:verified', toPublic(r));
    else this.io?.emit('report:removed', { id: r.id });
  }

  /** Coalesces bursts of submissions into one cluster scan. Returns a promise. */
  #debounced(fn, ms = 250) {
    let pending = null;
    return () => {
      if (!pending) {
        pending = new Promise((resolve) => {
          this.#timer = setTimeout(async () => {
            pending = null;
            this.#timer = null;
            try { resolve(await fn()); } catch (e) { console.error('cluster check failed', e); resolve([]); }
          }, ms);
        });
      }
      return pending;
    };
  }

  /** Stops pending work and closes all sockets. */
  close() {
    clearTimeout(this.#timer);
    this.io?.close();
  }
}
