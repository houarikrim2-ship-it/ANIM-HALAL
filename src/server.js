import { createServer } from 'node:http';
import express from 'express';
import { HOST, PORT, UPSTREAM_ALLOWED_HOSTS } from './config.js';
import hlsRouter from './routes/hls.js';

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'authorized-hls-relay',
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
});

app.use('/', hlsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, _req, res, next) => {
  console.error('[relay] unhandled error:', err?.message);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

const server = createServer(app);

let shuttingDown = false;
let forceTimer = null;

export function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[relay] received ${signal}, shutting down...`);

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  forceTimer = setTimeout(() => {
    console.error('[relay] grace period expired, force-closing remaining connections');
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    process.exit(1);
  }, 10_000);
  if (typeof forceTimer.unref === 'function') {
    forceTimer.unref();
  }

  server.close((err) => {
    if (forceTimer) {
      clearTimeout(forceTimer);
      forceTimer = null;
    }
    if (err) {
      console.error('[relay] shutdown error:', err.message);
      process.exit(1);
    }
    console.log('[relay] shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(
    `[relay] listening on http://${HOST}:${PORT} (upstream allowlist: ${UPSTREAM_ALLOWED_HOSTS.join(', ')})`
  );
});

export { app, server };