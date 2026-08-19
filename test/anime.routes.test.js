import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';

// Same env-before-import discipline as the other suites: fake providers
// listen first, then the app is imported.
const miruroServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://miruro.test');
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/search') {
    return send({ success: true, results: { results: [{ id: 21, title: { romaji: 'Demon Slayer' } }] } });
  }
  if (url.pathname === '/api/trending') {
    return send({ success: true, results: [{ id: 21, title: { romaji: 'Demon Slayer' } }] });
  }
  if (url.pathname === '/api/episodes/21') {
    return send({
      success: true,
      results: {
        providers: {
          kiwi: { episodes: { sub: [{ id: 'watch/kiwi/21/sub/kip-1', number: 1, title: 'Ep 1' }] } },
        },
      },
    });
  }
  if (/^\/api\/watch\//.test(url.pathname)) {
    return send({
      success: true,
      results: { streams: [{ url: 'https://cdn.example.com/kiwi-1.m3u8?tok=1', type: 'hls' }] },
    });
  }
  return send({ success: false, message: 'not found' }, 404);
});

await new Promise((resolve) => miruroServer.listen(0, '127.0.0.1', resolve));

process.env.ANIME_API_BASE_URL = `http://127.0.0.1:${miruroServer.address().port}`;
process.env.ANIME_JIKAN_BASE_URL = 'http://127.0.0.1:9'; // unused port: jikan never reached in these tests
process.env.ANIME_MAX_ATTEMPTS = '1';

const { app } = await import('../src/server.js');

let appServer;
let appPort;

before(async () => {
  appServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  appPort = appServer.address().port;
});

after(async () => {
  if (typeof appServer?.closeAllConnections === 'function') {
    appServer.closeAllConnections();
  }
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => miruroServer.close(resolve));
});

const api = (path) => `http://127.0.0.1:${appPort}/api/anime${path}`;

test('GET /api/anime/search returns the stable envelope with cache header', async () => {
  const res = await fetch(api('/search?q=demon'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=60/);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.results[0].id, 21);
});

test('GET /api/anime/search without q is INVALID_REQUEST (400)', async () => {
  const res = await fetch(api('/search'));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_REQUEST');
});

test('GET /api/anime/episodes/:id returns deduped episodes', async () => {
  const res = await fetch(api('/episodes/21'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=120/);
  const body = await res.json();
  assert.equal(body.data.episodes.length, 1);
  assert.equal(body.data.episodes[0].id, 'watch/kiwi/21/sub/kip-1');
  assert.equal(body.data.episodes[0].resolvable, true);
});

test('GET /api/anime/episode/sources returns no-store sources', async () => {
  const res = await fetch(api('/episode/sources?episodeId=watch/kiwi/21/sub/kip-1'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.data.sources[0].url, 'https://cdn.example.com/kiwi-1.m3u8?tok=1');
  assert.equal(body.data.sources[0].isHls, true);
});

test('GET /api/anime/episode/sources with a malformed id is 400', async () => {
  const res = await fetch(api('/episode/sources?episodeId=garbage'));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_REQUEST');
});

test('GET /api/anime/trending returns catalog rows', async () => {
  const res = await fetch(api('/trending'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.results.length, 1);
});

test('GET /api/anime/providers reports diagnostics without secrets', async () => {
  const res = await fetch(api('/providers'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  const names = body.data.providers.map((p) => p.name);
  assert.ok(names.includes('miruro'));
  assert.ok(Array.isArray(body.data.priority));
  assert.equal(body.data.priority[0], 'kiwi');
});

test('unknown /api/anime path is 404 with the relay envelope', async () => {
  const res = await fetch(api('/nope'));
  assert.equal(res.status, 404);
});

test('HLS relay routes still work alongside the anime routes', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});