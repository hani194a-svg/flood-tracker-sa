import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { Realtime } from './realtime.js';
import { pool } from './db.js';

const server = http.createServer();
const realtime = Realtime.attach(server, config.corsOrigins);
server.on('request', createApp({ realtime }));

// Periodic sweep so clusters that grow via admin actions or time are still caught
const sweep = setInterval(() => realtime.checkClusters(), 60_000);

server.listen(config.port, () => {
  console.log(`API + Socket.io listening on :${config.port}`);
});

function shutdown() {
  clearInterval(sweep);
  realtime.close();
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
