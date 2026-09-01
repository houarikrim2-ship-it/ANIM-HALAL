/**
 * Scraper registry aggregation tests.
 *
 * When more than one scraper provider resolves the same episode, sources from
 * every provider are preserved instead of stopping at the first hit, while
 * `provider` stays the highest-priority contributor. All fetches stay on a
 * local fake site.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http from 'node:http';

function base64(value) {
  return Buffer.from(value, 'latin1').toString('base64');
}

function xorBytes(text, keyText) {
  const data = Buffer.from(text, 'latin1');
  const key = Buffer.from(keyText, 'latin1');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out;
}

/** `processedEpisodeData` payload (rnd.js format). */
function witanimeGridScript(entries) {
  const key = 'aggkey';
  const json = `[${entries
    .map((entry) => `{"number":"${entry.number}","url":"${entry.url}","watched":false}`)
    .join(',')}]`;
  return `var processedEpisodeData = '${base64(xorBytes(json, key).toString('latin1'))}.${base64(key)}'`;
}

/** `_zT`/`_zV` iframe resources (yh00.js format). */
function witanimeIframeScript(urls) {
  const resources = urls.map((url) => {
    let junkLength = 1;
    while ((url.length + junkLength) % 3 !== 0) junkLength += 1;
    const junk = 'X'.repeat(junkLength);
    return base64(`${url}${junk}`).split('').reverse().join('');
  });
  const configs = urls.map((url) => {
    const junkLength = 1 + (3 - ((url.length + 1) % 3)) % 3;
    return `{"d":[${junkLength},0],"k":"${base64('0')}"}`;
  });
  const zt = `var _zT = "${base64(`["${resources.join('","')}"]`)}";`;
  const zv = `var _zV = "${base64(`[${configs.join(',')}]`)}";`;
  return `${zt}\n${zv}`;
}

function htmlPage(body) {
  return `<!DOCTYPE html><html><head><title>Aggregation</title></head><body>${body}</body></html>`;
}

let server;
let registry;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/?s=') && /one|piece/i.test(url)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        htmlPage(`
          <div class="anime-grid">
            <div class="anime-card">
              <h3 class="anime-card-title"><a href="/anime/one-piece">One Piece</a></h3>
            </div>
          </div>`),
      );
      return;
    }
    if (url === '/anime/one-piece') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        htmlPage(`
          <ul class="episodes">
            <li><a href="/anime/one-piece/1">الحلقة 1</a></li>
            <li><a href="/anime/one-piece/2">الحلقة 2</a></li>
          </ul>
          <script>${witanimeGridScript([
            { number: 1, url: '/anime/one-piece/1' },
            { number: 2, url: '/anime/one-piece/2' },
          ])}</script>`),
      );
      return;
    }
    if (url === '/anime/one-piece/2') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        htmlPage(`
          <div id="episode-servers">
            <li data-watch="https://w1.anime4up.rest/v/2.mp4" data-name="سيرفر FHD">s1</li>
            <li data-watch="https://w1.anime4up.rest/v/2.m3u8" data-name="سيرفر HD">s2</li>
            <li data-watch="https://embed.example/v2?id=99" data-name="سيرفر مباشر">s3</li>
            <li data-watch="https://embed2.example/v?id=7" data-name="سيرفر إضافي">s4</li>
          </div>
          <script>
            var jwConfig = { sources: [{ file: "https://cdn.anime4up.example/2.m3u8", label: "HD" }] };
            ${witanimeIframeScript(['https://embed.example/e/xyz', 'https://embed.example/e/abc'])}
          </script>`),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(htmlPage('Not found'));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.ANIME_SCRAPER_ENABLED = 'true';
  process.env.ANIME_SCRAPER_TIMEOUT_MS = '2000';
  process.env.ANIME_SCRAPER_PRIORITY = 'witanime,anime4up';
  process.env.ANIME_WITANIME_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANIME_ANIME4UP_BASE_URL = `http://127.0.0.1:${port}`;
  registry = await import('../src/anime/providers/scraperRegistry.js');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('registry: aggregates sources from every provider that resolves the episode', async () => {
  const result = await registry.resolveEpisodeSources({ title: 'One Piece', episodeNumber: 2 });
  assert.ok(result.sources.length >= 2, 'expected sources from both providers');
  assert.equal(result.provider, 'witanime', 'highest-priority contributor wins as provider');

  const providers = new Set(result.sources.map((source) => source.provider));
  assert.ok(
    providers.has('witanime') && providers.has('anime4up'),
    `sources must come from both providers, got ${[...providers].join(', ')}`,
  );

  const anime4up = result.sources.filter((source) => source.provider === 'anime4up');
  const witanime = result.sources.filter((source) => source.provider === 'witanime');
  // anime4up yields 2 direct + jwConfig direct + 2 embed fallbacks.
  assert.ok(anime4up.length >= 3, `anime4up provider contributed fewer sources than expected: ${anime4up.length}`);
  // witanime yields its 2 watch-embed fallbacks.
  assert.equal(witanime.length, 2, 'witanime contributed its watch-server embeds');

  // Every source is normalized and playable-shaped (no raw strings).
  for (const source of result.sources) {
    assert.equal(typeof source.url, 'string');
    assert.ok(source.url.startsWith('http'), `bad url ${source.url}`);
    assert.ok(['DIRECT', 'EMBED'].includes(source.extractionStatus), 'each source carries a status');
  }
});

test('registry: a per-provider miss still fails over to the other providers', async () => {
  const result = await registry.resolveEpisodeSources({ title: 'Does Not Exist Anywhere', episodeNumber: 1 });
  assert.equal(result.sources.length, 0);
  assert.ok(result.failures.length >= 1, 'failures must be recorded');
  assert.ok(result.failures.every((failure) => typeof failure.category === 'string' && failure.category.length > 0));
});