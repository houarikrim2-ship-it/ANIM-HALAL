import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import dns from 'node:dns';

// Configuration must be settled BEFORE the app modules are imported. ESM
// hoists static imports above statements, so app imports are dynamic.
process.env.UPSTREAM_ALLOWED_HOSTS = 'upstream.test';
process.env.MAX_MANIFEST_BYTES = '1024';

const { encodeSrc } = await import('../src/hlsRewriter.js');

// Route the fake allowlisted hostname to the loopback upstream server.
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

// Deterministic 16-byte AES-128 key containing bytes that are NOT valid
// UTF-8 (0x8a, 0x9b), NUL bytes, 0xff, and a trailing newline.
const TEST_KEY = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x8a, 0x9b, 0xfe, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x0a]);

// 1 MiB deterministic binary segment exercising every byte value.
const SEGMENT_BYTES = 1_000_000;
const TEST_SEGMENT = Buffer.alloc(SEGMENT_BYTES);
for (let i = 0; i < SEGMENT_BYTES; i += 1) {
  TEST_SEGMENT[i] = (i * 31 + (i >> 8)) % 256;
}

const MANIFEST_BODY = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="https://upstream.test:PORT/keys/aes.key"
#EXTINF:6.0,
https://upstream.test:PORT/segs/00001.ts
#EXTINF:6.0,
/rootseg.ts?tok=1
#EXT-X-ENDLIST
`;

let upstreamPort;
const upstream = createServer((req, res) => {
  const url = new URL(req.url, `http://upstream.test:${upstreamPort}`);
  if (url.pathname === '/key' || url.pathname === '/keys/aes.key') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': TEST_KEY.length,
    });
    res.end(TEST_KEY);
    return;
  }
  if (url.pathname === '/seg.bin') {
    const range = req.headers.range;
    if (range !== undefined) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? SEGMENT_BYTES - Number(m[2]) : Number(m[1]);
        let end = m[1] === '' ? SEGMENT_BYTES - 1 : m[2] === '' ? SEGMENT_BYTES - 1 : Number(m[2]);
        if (start >= SEGMENT_BYTES || start > end) {
          res.writeHead(416, {
            'Content-Range': `bytes */${SEGMENT_BYTES}`,
            'Accept-Ranges': 'bytes',
          });
          res.end();
          return;
        }
        end = Math.min(end, SEGMENT_BYTES - 1);
        const body = TEST_SEGMENT.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'video/mp2t',
          'Content-Range': `bytes ${start}-${end}/${SEGMENT_BYTES}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': TEST_SEGMENT.length,
      'Accept-Ranges': 'bytes',
    });
    res.end(TEST_SEGMENT);
    return;
  }
  if (url.pathname === '/big.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(MANIFEST_BODY.replaceAll('PORT', String(upstreamPort)));
    return;
  }
  if (url.pathname === '/huge.m3u8') {
    const huge = '#EXTM3U\n' + ('#EXTINF:1,\nseg.ts\n'.repeat(300));
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(huge);
    return;
  }
  if (url.pathname === '/slow.bin') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000000' });
    res.flushHeaders();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

let app;
let appServer;
let appPort;

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;
  ({ app } = await import('../src/server.js'));
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
const toBuffer = async (response) => Buffer.from(await response.arrayBuffer());

test('AES-128 key is relayed byte-for-byte as application/octet-stream', async () => {
  const res = await fetch(relayUrl(`/key?src=${srcOf(`http://upstream.test:${upstreamPort}/keys/aes.key`)}`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/octet-stream/);
  const body = await toBuffer(res);
  assert.equal(body.length, 16);
  assert.equal(Buffer.compare(body, TEST_KEY), 0, 'key bytes must match upstream exactly');
});

test('segment without Range is relayed byte-for-byte with Content-Length', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/seg.bin`)}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(SEGMENT_BYTES));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  const body = await toBuffer(res);
  assert.equal(body.length, SEGMENT_BYTES);
  assert.equal(Buffer.compare(body, TEST_SEGMENT), 0, 'segment bytes must match upstream exactly');
});

test('Range bytes=0-99 yields 206 Partial Content with correct Content-Range', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/seg.bin`)}`), {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-99/${SEGMENT_BYTES}`);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), '100');
  const body = await toBuffer(res);
  assert.equal(Buffer.compare(body, TEST_SEGMENT.subarray(0, 100)), 0);
});

test('suffix Range bytes=-100 yields 206 with the trailing bytes', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/seg.bin`)}`), {
    headers: { Range: 'bytes=-100' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${SEGMENT_BYTES - 100}-${SEGMENT_BYTES - 1}/${SEGMENT_BYTES}`);
  const body = await toBuffer(res);
  assert.equal(Buffer.compare(body, TEST_SEGMENT.subarray(SEGMENT_BYTES - 100)), 0);
});

test('unsatisfiable Range is preserved as 416, never a successful media response', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/seg.bin`)}`), {
    headers: { Range: 'bytes=999999999-' },
  });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SEGMENT_BYTES}`);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('malformed Range headers are rejected with 416', async () => {
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/seg.bin`)}`), {
    headers: { Range: 'bytes=' },
  });
  assert.equal(res.status, 416);
});

test('manifest is UTF-8 text, starts with #EXTM3U, and rewrites key/segment/variant URIs', async () => {
  const res = await fetch(relayUrl(`/master.m3u8?src=${srcOf(`http://upstream.test:${upstreamPort}/big.m3u8`)}`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/vnd\.apple\.mpegurl/);
  const text = await res.text();
  assert.ok(text.startsWith('#EXTM3U'), 'manifest must begin with #EXTM3U');
  assert.ok(!text.startsWith('\uFEFF'), 'no BOM may precede #EXTM3U');
  assert.ok(!text.includes('undefined'));
  const keySrc = text.match(/URI="\/key\?src=([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(keySrc, 'EXT-X-KEY URI must be rewritten to /key');
  const keyUrl = Buffer.from(keySrc, 'base64url').toString('utf8');
  assert.equal(keyUrl, `https://upstream.test:${upstreamPort}/keys/aes.key`);
  const segmentSrcs = [...text.matchAll(/\/segment\?src=([A-Za-z0-9_-]+)/g)].map((m) =>
    Buffer.from(m[1], 'base64url').toString('utf8')
  );
  assert.ok(segmentSrcs.includes(`https://upstream.test:${upstreamPort}/segs/00001.ts`));
  assert.ok(
    segmentSrcs.includes(`http://upstream.test:${upstreamPort}/rootseg.ts?tok=1`),
    'root-relative URIs resolve against the fetched manifest base URL'
  );
});

test('manifests above the configured size limit are rejected with 413', async () => {
  const res = await fetch(relayUrl(`/master.m3u8?src=${srcOf(`http://upstream.test:${upstreamPort}/huge.m3u8`)}`));
  assert.equal(res.status, 413);
});

test('SSRF: disallowed hosts and loopback addresses are blocked with 403', async () => {
  const evil = await fetch(relayUrl(`/master.m3u8?src=${srcOf('http://evil.example.com/x.m3u8')}`));
  assert.equal(evil.status, 403);
  const loopback = await fetch(relayUrl(`/master.m3u8?src=${srcOf(`http://127.0.0.1:${upstreamPort}/big.m3u8`)}`));
  assert.equal(loopback.status, 403);
  const localhost = await fetch(relayUrl(`/master.m3u8?src=${srcOf(`http://localhost:${upstreamPort}/big.m3u8`)}`));
  assert.equal(localhost.status, 403);
});

test('missing or malformed src is rejected with 400', async () => {
  const missing = await fetch(relayUrl('/master.m3u8'));
  assert.equal(missing.status, 400);
  const malformed = await fetch(relayUrl('/key?src=!!!not-base64url!!!'));
  assert.equal(malformed.status, 400);
});

test('client cancellation aborts the upstream request', async () => {
  let upstreamClosed = false;
  upstream.once('request', (req, res) => {
    res.on('close', () => {
      upstreamClosed = true;
    });
  });

  const controller = new AbortController();
  const res = await fetch(relayUrl(`/segment?src=${srcOf(`http://upstream.test:${upstreamPort}/slow.bin`)}`), {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(upstreamClosed, 'upstream connection must be terminated after client abort');
});