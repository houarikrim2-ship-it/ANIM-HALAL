/**
 * Server-side provider host policy tests (spec §6).
 *
 * Verifies that per-host User-Agent / Referer / Origin policies configured by
 * the operator are applied by the relay before every upstream request, that
 * they ALWAYS override whatever a client src payload declares, and that
 * subdomain hosts inherit the longest matching registered policy. Client
 * payloads can never inject policy headers — the relay simply ignores
 * non-policy sources.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import dns from 'node:dns';

process.env.UPSTREAM_ALLOWED_HOSTS = 'upstream.test,other.test';
process.env.UPSTREAM_ALLOW_SUBDOMAINS = 'true';
process.env.UPSTREAM_ALLOW_PRIVATE_RESOLUTION = 'true';
process.env.UPSTREAM_RETRY_MAX_ATTEMPTS = '0';
process.env.UPSTREAM_PROVIDER_HEADERS = JSON.stringify({
  'upstream.test': {
    'User-Agent': 'policy-ua/1.0',
    'Referer': 'https://policy.example/watch',
    'Origin': 'https://policy.example',
  },
  'other.test': {
    'User-Agent': 'other-ua/1.0',
  },
});

const { encodeSrc, encodeSrcRef } = await import('../src/hlsRewriter.js');
const { providerHeadersFor } = await import('../src/config.js');

// ── Unit: policy lookup ─────────────────────────────────────────────────────

test('providerHeadersFor returns the exact-host policy', () => {
  const policy = providerHeadersFor('upstream.test');
  assert.equal(policy['User-Agent'], 'policy-ua/1.0');
  assert.equal(policy['Referer'], 'https://policy.example/watch');
  assert.equal(policy['Origin'], 'https://policy.example');
});

test('providerHeadersFor matches subdomains against the longest registered parent', () => {
  const policy = providerHeadersFor('cdn.upstream.test');
  assert.equal(policy['User-Agent'], 'policy-ua/1.0');
});

test('providerHeadersFor returns null for hosts without a policy', () => {
  assert.equal(providerHeadersFor('unrelated.example'), null);
  assert.equal(providerHeadersFor('upstream.test.evil.example'), null);
});

// ── E2E: policy headers reach the upstream and beat client headers ──────────

const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const entry = { address: '127.0.0.1', family: 4 };
  if (options.all) {
    return callback(null, [entry]);
  }
  return callback(null, entry.address, entry.family);
};

const received = {};

let upstreamPort;
const upstream = createServer((req, res) => {
  const url = new URL(req.url, `http://upstream.test:${upstreamPort}`);
  received[url.pathname] = {
    'User-Agent': req.headers['user-agent'],
    Referer: req.headers.referer ?? '',
    Origin: req.headers.origin ?? '',
  };
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

test('policy User-Agent/Referer/Origin are applied to the upstream request', async () => {
  const res = await fetch(relayUrl(`/segment?src=${encodeSrc(`http://upstream.test:${upstreamPort}/a.ts`)}`));
  assert.equal(res.status, 200);
  const seen = received['/a.ts'];
  assert.equal(seen['User-Agent'], 'policy-ua/1.0', 'policy UA must replace the relay default');
  assert.equal(seen.Referer, 'https://policy.example/watch');
  assert.equal(seen.Origin, 'https://policy.example');
});

test('policy headers override client-declared playback headers', async () => {
  const src = encodeSrcRef(`http://upstream.test:${upstreamPort}/b.ts`, {
    Referer: 'https://client.example/',
    Origin: 'https://client.example',
  });
  const res = await fetch(relayUrl(`/segment?src=${src}`));
  assert.equal(res.status, 200);
  const seen = received['/b.ts'];
  assert.equal(seen.Referer, 'https://policy.example/watch', 'policy must win over the src payload');
  assert.equal(seen.Origin, 'https://policy.example');
  assert.equal(seen['User-Agent'], 'policy-ua/1.0');
});

test('a host without a policy keeps the honest default headers', async () => {
  const res = await fetch(relayUrl(`/segment?src=${encodeSrc(`http://other.test:${upstreamPort}/c.ts`)}`));
  assert.equal(res.status, 200);
  const seen = received['/c.ts'];
  assert.equal(seen['User-Agent'], 'other-ua/1.0');
  assert.equal(seen.Referer, '', 'no Referer unless the policy (or src payload) declares it');
});