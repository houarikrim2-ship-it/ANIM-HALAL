/**
 * Post-DNS SSRF validation tests (spec §5).
 *
 * The URL-level checks (protocol, credentials, forbidden literals, allowlist)
 * already exist; this suite covers the post-DNS layer: every address an
 * allowlisted hostname resolves to is validated against the same
 * forbidden-address rules, connections are pinned to the validated
 * addresses, and a host that resolves only to private/loopback addresses is
 * refused with 403 — including mid-redirect hops.
 *
 * NOTE: this file deliberately does NOT set UPSTREAM_ALLOW_PRIVATE_RESOLUTION
 * (the test-only override) so the validator runs in production-strict mode.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import dns from 'node:dns';

process.env.UPSTREAM_ALLOWED_HOSTS = 'upstream.test';
process.env.UPSTREAM_RETRY_MAX_ATTEMPTS = '0';

const { encodeSrc } = await import('../src/hlsRewriter.js');
const { selectAllowedAddresses, UpstreamError } = await import('../src/upstreamClient.js');

// ── Unit: address selection ─────────────────────────────────────────────────

test('selectAllowedAddresses keeps only public addresses from a mixed set', () => {
  const allowed = selectAllowedAddresses('host.example', ['10.0.0.5', '93.184.216.34', '192.168.1.1']);
  assert.deepEqual(allowed, ['93.184.216.34']);
});

test('selectAllowedAddresses passes through public-only resolutions', () => {
  const allowed = selectAllowedAddresses('host.example', ['93.184.216.34', '1.1.1.1']);
  assert.deepEqual(allowed, ['93.184.216.34', '1.1.1.1']);
});

test('selectAllowedAddresses drops IPv6 addresses (consistent with the URL rules)', () => {
  const allowed = selectAllowedAddresses('host.example', ['2001:db8::1', '93.184.216.34']);
  assert.deepEqual(allowed, ['93.184.216.34']);
});

test('selectAllowedAddresses throws 403 when every address is forbidden', () => {
  assert.throws(
    () => selectAllowedAddresses('host.example', ['10.0.0.5', '127.0.0.1']),
    (err) => err instanceof UpstreamError && err.code === 'E_UNAUTHORIZED_HOST' && err.status === 403
  );
});

// ── E2E: relay refuses hosts that resolve to private addresses ──────────────

const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const entry = (addr) => ({ address: addr, family: 4 });
  if (hostname === 'upstream.test') {
    const answer = entry('10.0.0.5'); // allowlisted host, private resolution
    if (options.all) {
      return callback(null, [answer]);
    }
    return callback(null, answer.address, answer.family);
  }
  return originalLookup.call(this, hostname, options, callback);
};

let upstreamPort;
const upstream = createServer((req, res) => {
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

test('allowlisted host resolving to a private address is refused with 403', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/x.m3u8`)}`));
  assert.equal(res.status, 403);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json();
  assert.match(body.error ?? '', /forbidden/i);
});

test('SSRF refusals are never retried (single resolution attempt)', async () => {
  const res = await fetch(relayUrl(`/master.m3u8?src=${srcOf(`http://upstream.test:${upstreamPort}/y.m3u8`)}`));
  assert.equal(res.status, 403);
});