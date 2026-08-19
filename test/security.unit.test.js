import assert from 'node:assert/strict';
import { test } from 'node:test';

// Settle a deterministic configuration before the app modules load (ESM
// hoists static imports, so app imports are dynamic).
process.env.UPSTREAM_ALLOWED_HOSTS =
  'uqload.io,uqload.is,uqload.vc,share4max.com,anime4up.rest,w1.anime4up.rest,4d.h6m1c9q.shop';
process.env.UPSTREAM_ALLOW_SUBDOMAINS = 'false';

const { encodeSrc, decodeSrc, rewriteManifest, buildRelayPath } = await import('../src/hlsRewriter.js');
const { isHostAllowed, isForbiddenAddress, UPSTREAM_ALLOWED_HOSTS, UPSTREAM_ALLOW_SUBDOMAINS } =
  await import('../src/config.js');
const { validateUpstreamUrl, UpstreamError } = await import('../src/upstreamClient.js');

test('allowlist matches only the configured exact hosts', () => {
  assert.ok(UPSTREAM_ALLOWED_HOSTS.includes('uqload.io'));
  for (const host of UPSTREAM_ALLOWED_HOSTS) {
    assert.ok(isHostAllowed(host), `${host} must be allowed`);
  }
  assert.ok(!isHostAllowed('example.com'));
  assert.ok(!isHostAllowed('attacker-uqload.io'));
  assert.ok(!isHostAllowed('uqload.io.attacker.com'));
  assert.ok(!isHostAllowed('uqload.io.'), 'trailing-dot alias is stripped before allowlist checks');
  if (!UPSTREAM_ALLOW_SUBDOMAINS) {
    assert.ok(!isHostAllowed('cdn.uqload.io'), 'subdomains are rejected when UPSTREAM_ALLOW_SUBDOMAINS=false');
  }
});

test('forbidden addresses are rejected regardless of allowlist', () => {
  assert.ok(isForbiddenAddress('localhost'));
  assert.ok(isForbiddenAddress('api.localhost'));
  assert.ok(isForbiddenAddress('127.0.0.1'));
  assert.ok(isForbiddenAddress('10.0.0.5'));
  assert.ok(isForbiddenAddress('192.168.100.37'));
  assert.ok(isForbiddenAddress('172.16.0.1'));
  assert.ok(isForbiddenAddress('172.31.255.255'));
  assert.ok(isForbiddenAddress('169.254.169.254'));
  assert.ok(isForbiddenAddress('100.64.0.1'));
  assert.ok(isForbiddenAddress('0.0.0.0'));
  assert.ok(isForbiddenAddress('224.0.0.1'));
  assert.ok(isForbiddenAddress('::1'));
  assert.ok(isForbiddenAddress('2001:db8::1'));
});

test('public non-allowlisted hosts are not forbidden addresses but are denied by the allowlist', () => {
  assert.ok(!isForbiddenAddress('8.8.8.8'));
  assert.ok(!isHostAllowed('8.8.8.8'));
});

test('validateUpstreamUrl rejects non-http, credentials, and disallowed hosts', () => {
  for (const bad of [
    'ftp://uqload.io/file.ts',
    'file:///etc/passwd',
    'http://user:pass@uqload.io/file.ts',
    'http://example.com/file.ts',
    'http://127.0.0.1/file.ts',
    'http://localhost/file.ts',
    'http://uqload.io.attacker.com/file.ts',
  ]) {
    assert.throws(
      () => validateUpstreamUrl(bad),
      (err) => err instanceof UpstreamError,
      `${bad} must be rejected`
    );
  }
});

test('validateUpstreamUrl accepts an allowed host and preserves query strings', () => {
  const url = validateUpstreamUrl('https://uqload.io/path/seg.ts?token=abc&e=123');
  assert.equal(url.href, 'https://uqload.io/path/seg.ts?token=abc&e=123');
});

test('base64url src roundtrip preserves the exact upstream URL', () => {
  const raw = 'https://uqload.io/v/abc123/index.m3u8?token=xyz';
  assert.equal(decodeSrc(encodeSrc(raw)), raw);
});

test('src decoding rejects oversized and malformed references', () => {
  assert.throws(() => decodeSrc(''), UpstreamError);
  assert.throws(() => decodeSrc('not base64url!'), UpstreamError);
  assert.throws(() => decodeSrc('A'.repeat(33_000)), UpstreamError);
  assert.throws(() => decodeSrc(encodeSrc('https://uqload.io/' + 'x'.repeat(9000))), UpstreamError);
});

test('rewritten manifests begin with #EXTM3U and never contain object/buffer artifacts', () => {
  const manifestUrl = 'https://uqload.io/v/abc/index.m3u8';
  const input = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720',
    'https://uqload.io/v/abc/720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=256000',
    '../master_low.m3u8?x=1',
  ].join('\n');
  const out = rewriteManifest(input, manifestUrl);
  assert.ok(out.startsWith('#EXTM3U'));
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('[object Object]'));
  assert.ok(out.includes('/master.m3u8?src='));
});

test('EXT-X-KEY URIs are rewritten to the relay /key route with encoded sources', () => {
  const manifestUrl = 'https://uqload.io/v/abc/index.m3u8';
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://uqload.io/keys/aes.key",IV=0x01\nseg1.ts';
  const out = rewriteManifest(input, manifestUrl);
  const match = out.match(/URI="(\/key\?src=[^"]+)"/);
  assert.ok(match, 'key URI must be rewritten to the relay');
  assert.equal(decodeSrc(match[1].replace('/key?src=', '')), 'https://uqload.io/keys/aes.key');
  assert.ok(out.includes('/segment?src='), 'segment line must be rewritten to the relay');
});

test('root-relative, relative, and query URIs are rewritten with the manifest URL as base', () => {
  const manifestUrl = 'https://uqload.io/v/abc/index.m3u8';
  const input = '#EXTM3U\n/seg/00001.ts\nrel/dir/00002.ts?r=1\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART:URI="part0.mp4"\n';
  const out = rewriteManifest(input, manifestUrl);
  assert.ok(out.includes('/segment?src='));
  const decoded = [...out.matchAll(/\/segment\?src=([A-Za-z0-9_-]+)/g)].map((m) => decodeSrc(m[1]));
  assert.ok(decoded.includes('https://uqload.io/seg/00001.ts'));
  assert.ok(decoded.includes('https://uqload.io/v/abc/rel/dir/00002.ts?r=1'));
  assert.ok(decoded.includes('https://uqload.io/v/abc/init.mp4'));
});

test('EXT-X-MEDIA and I-FRAME-STREAM-INF URIs route to /master.m3u8', () => {
  const manifestUrl = 'https://uqload.io/v/abc/index.m3u8';
  const input = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=64000,URI="iframe.m3u8"',
  ].join('\n');
  const out = rewriteManifest(input, manifestUrl);
  const decoded = [...out.matchAll(/\/master\.m3u8\?src=([A-Za-z0-9_-]+)/g)].map((m) => decodeSrc(m[1]));
  assert.ok(decoded.includes('https://uqload.io/v/abc/audio.m3u8'));
  assert.ok(decoded.includes('https://uqload.io/v/abc/iframe.m3u8'));
});

test('buildRelayPath routes by resource kind', () => {
  const url = new URL('https://uqload.io/seg.ts');
  assert.equal(buildRelayPath('key', url), `/key?src=${encodeSrc(url.href)}`);
  assert.equal(buildRelayPath('segment', url), `/segment?src=${encodeSrc(url.href)}`);
  assert.equal(buildRelayPath('master', url), `/master.m3u8?src=${encodeSrc(url.href)}`);
});