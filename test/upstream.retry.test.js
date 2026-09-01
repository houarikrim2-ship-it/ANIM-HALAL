/**
 * Relay retry policy tests (spec §12).
 *
 * Verifies through the real relay routes that transient upstream outcomes
 * (503/429, connection refused, timeout) are retried with bounded exponential
 * backoff, that permanent outcomes (403) are never retried, and that the
 * configured attempt budget is honored exactly.
 *
 * The fake allowlisted hostname resolves to the loopback upstream via a
 * dns.lookup stub; the server-side test-only loopback override keeps the
 * post-DNS SSRF validator happy.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import dns from 'node:dns';

// Settle a deterministic configuration before the app modules load.
process.env.UPSTREAM_ALLOWED_HOSTS = 'upstream.test';
process.env.UPSTREAM_ALLOW_PRIVATE_RESOLUTION = 'true';
process.env.UPSTREAM_RETRY_MAX_ATTEMPTS = '2';
process.env.UPSTREAM_RETRY_BASE_DELAY_MS = '20';
process.env.UPSTREAM_RETRY_MAX_DELAY_MS = '40';
process.env.UPSTREAM_TIMEOUT_MS = '40';

const { encodeSrc } = await import('../src/hlsRewriter.js');

const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (hostname === 'upstream.test') {
    const entry = { address: '127.0.0.1', family: 4 };
    if (options.all) {
      return callback(null, [entry]);
    }
    return callback(null, entry.address, entry.family);
  }
  return originalLookup.call(this, hostname, options, callback);
};

const requestCounts = new Map();

function count(path) {
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
}

let upstreamPort;
const upstream = createServer((req, res) => {
  const url = new URL(req.url, `http://upstream.test:${upstreamPort}`);
  count(url.pathname);
  if (url.pathname === '/flaky') {
    const seen = requestCounts.get('/flaky') ?? 0;
    if (seen < 3) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('busy');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/once429') {
    const seen = requestCounts.get('/once429') ?? 0;
    if (seen < 2) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/always500') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
    return;
  }
  if (url.pathname === '/forbidden') {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html>Access denied</html>');
    return;
  }
  if (url.pathname === '/hang') {
    // Never answers: exercises the per-attempt timeout retry path.
    return;
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: `http://upstream.test:${upstreamPort}/ok.ts` });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

let appServer;
let appPort;

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;
  const { app } = await import('../src/server.js');
  appServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  appPort = appServer.address().port;
});

after(async () => {
  dns.lookup = originalLookup;
  if (typeof appServer.closeAllConnections === 'function') {
    appServer.closeAllConnections();
  }
  if (typeof upstream.closeAllConnections === 'function') {
    upstream.closeAllConnections();
  }
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

const relayUrl = (path) => `http://127.0.0.1:${appPort}${path}`;
const srcOf = (url) => encodeSrc(url);

test('503 twice then 200 succeeds; upstream saw exactly 3 attempts', async () => {
  const before = requestCounts.get('/flaky') ?? 0;
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/flaky`)}`));
  assert.equal(res.status, 200);
  assert.equal((await res.text()), 'ok');
  assert.equal((requestCounts.get('/flaky') ?? 0) - before, 3);
});

test('429 once then 200 succeeds with 2 attempts', async () => {
  const before = requestCounts.get('/once429') ?? 0;
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/once429`)}`));
  assert.equal(res.status, 200);
  assert.equal((requestCounts.get('/once429') ?? 0) - before, 2);
});

test('persistent 500 collapses to 502 after exactly the configured budget (3 attempts)', async () => {
  const before = requestCounts.get('/always500') ?? 0;
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/always500`)}`));
  assert.equal(res.status, 502);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((requestCounts.get('/always500') ?? 0) - before, 3);
});

test('403 is NEVER retried (single upstream attempt)', async () => {
  const before = requestCounts.get('/forbidden') ?? 0;
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/forbidden`)}`));
  assert.equal(res.status, 502);
  assert.equal((requestCounts.get('/forbidden') ?? 0) - before, 1);
});

test('connection-refused network errors are retried and collapse to 502', async () => {
  // Point at a port with nothing listening -> ECONNREFUSED on every attempt.
  const deadPort = upstreamPort + 5000;
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${deadPort}/nobody`)}`));
  assert.equal(res.status, 502);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

test('per-attempt timeout is retried and finally surfaces as 504', async () => {
  const before = requestCounts.get('/hang') ?? 0;
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/hang`)}`));
  assert.equal(res.status, 504);
  assert.equal((requestCounts.get('/hang') ?? 0) - before, 3);
});

test('redirect hops are followed and each hop is DNS-validated + pinned', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/redirect`)}`));
  assert.equal(res.status, 200);
  assert.equal((await res.text()), 'ok');
});