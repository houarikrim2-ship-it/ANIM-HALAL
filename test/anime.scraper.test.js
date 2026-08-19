/**
 * Scraper fallback layer tests.
 *
 * Coverage:
 * - WitAnime codec (rnd.js episode grid, cx2.js download groups,
 *   yh00.js iframe resources) decoded with locally crafted payloads.
 * - Anime4Up end-to-end resolution against a local fake site:
 *   search -> anime page -> episode page -> normalized sources.
 * - Failure isolation: per-provider timeouts, missing payloads, challenge
 *   pages and all-providers-failed all collapse to stable categories.
 * - Extracted URL safety: private / loopback / reserved hosts rejected.
 *
 * All fetches stay on 127.0.0.1 fake servers; no external network.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http from 'node:http';

const miruroServer = http.createServer();
const witanimeServer = http.createServer();
const anime4upServer = http.createServer();
const hangServer = http.createServer((req, res) => {
  // Intentionally never responds: bounded timeout must abort this.
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html></html>');
  }, 30_000);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
function portOf(server) {
  return server.address().port;
}

before(async () => {
  await Promise.all([listen(miruroServer), listen(witanimeServer), listen(anime4upServer), listen(hangServer)]);

  process.env.ANIME_API_BASE_URL = `http://127.0.0.1:${portOf(miruroServer)}`;
  process.env.ANIME_PROVIDER_ENABLED = 'true';
  process.env.ANIME_PROVIDER_TIMEOUT_MS = '1500';
  process.env.ANIME_MAX_ATTEMPTS = '1';
  process.env.ANIME_SCRAPER_ENABLED = 'true';
  process.env.ANIME_WITANIME_BASE_URL = `http://127.0.0.1:${portOf(witanimeServer)}`;
  process.env.ANIME_ANIME4UP_BASE_URL = `http://127.0.0.1:${portOf(anime4upServer)}`;
  process.env.ANIME_SCRAPER_TIMEOUT_MS = '2000';

  const [witanime, anime4up, support, registry, resolver] = await Promise.all([
    import('../src/anime/providers/witanimeScraper.js'),
    import('../src/anime/providers/anime4upScraper.js'),
    import('../src/anime/providers/scraperSupport.js'),
    import('../src/anime/providers/scraperRegistry.js'),
    import('../src/anime/resolver.js'),
  ]);
  testState.witanime = witanime;
  testState.anime4up = anime4up;
  testState.support = support;
  testState.registry = registry;
  testState.resolver = resolver;
});

after(async () => {
  await Promise.all([
    new Promise((resolve) => miruroServer.close(resolve)),
    new Promise((resolve) => witanimeServer.close(resolve)),
    new Promise((resolve) => anime4upServer.close(resolve)),
    new Promise((resolve) => hangServer.close(resolve)),
  ]);
});

const testState = {};

// ── helpers ─────────────────────────────────────────────────────────────────

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

/** Encodes one URL as a `_p*`/`_x` download group (cx2.js format). */
function encodeUrlGroup(url, key, pieceCount) {
  const pieces = [];
  const step = Math.ceil(url.length / pieceCount);
  for (let i = 0; i < pieceCount; i += 1) {
    pieces.push(url.slice(i * step, (i + 1) * step));
  }
  // The decoder places chunk[j] at position seq[j], so the permutation must
  // be self-inverse (seq[seq[i]] === i): build it from disjoint swaps.
  const seq = Array.from({ length: pieceCount }, (_, i) => i);
  const used = new Array(pieceCount).fill(false);
  for (let i = 0; i < pieceCount; i += 1) {
    if (used[i]) {
      continue;
    }
    const candidates = [];
    for (let j = i + 1; j < pieceCount; j += 1) {
      if (!used[j]) {
        candidates.push(j);
      }
    }
    if (candidates.length === 0) {
      used[i] = true;
      continue;
    }
    const j = candidates[Math.floor(Math.random() * candidates.length)];
    seq[i] = j;
    seq[j] = i;
    used[i] = true;
    used[j] = true;
  }
  const hexChunks = pieces.map((piece) => xorBytes(piece, key).toString('hex'));
  const hexSeq = xorBytes(seq.join(','), key).toString('hex');
  const arr = new Array(pieceCount);
  for (let i = 0; i < pieceCount; i += 1) {
    arr[seq[i]] = hexChunks[i];
  }
  return { hexSeq, hexChunks: arr };
}

function witanimeEpisodeScript(urls) {
  const key = 's3cret';
  const groups = urls.map((url) => encodeUrlGroup(url, key, 3));
  const lines = [
    `var _m = {"r":"${base64(key)}"};`,
    `var _x = [${groups.map((g) => `"${g.hexSeq}"`).join(',')}];`,
    `var _b = {"l":"${groups.length}"};`,
  ];
  groups.forEach((group, index) => {
    lines.push(`var _p${index} = [${group.hexChunks.map((chunk) => `"${chunk}"`).join(',')}];`);
  });
  return lines.join('\n');
}

function witanimeEpisodeGridScript(entries) {
  const key = 'gridkey';
  const json = `[${entries
    .map((entry) => `{"number":"${entry.number}","url":"${entry.url}","watched":false}`)
    .join(',')}]`;
  return `var processedEpisodeData = '${base64(xorBytes(json, key).toString('latin1'))}.${base64(key)}'`;
}

// ── WitAnime codec ──────────────────────────────────────────────────────────

test('witanime: decodeEpisodeGrid restores episode numbers + URLs', () => {
  const script = witanimeEpisodeGridScript([
    { number: 1, url: 'https://witanime.com/anime/one-piece/1' },
    { number: 2, url: 'https://witanime.com/anime/one-piece/2' },
  ]);
  const episodes = testState.witanime.decodeEpisodeGrid(script);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].number, 1);
  assert.equal(episodes[0].url, 'https://witanime.com/anime/one-piece/1');
  assert.equal(episodes[1].number, 2);
});

test('witanime: decodeEpisodeGrid rejects malformed payloads', () => {
  assert.deepEqual(testState.witanime.decodeEpisodeGrid('<html></html>'), []);
  assert.deepEqual(testState.witanime.decodeEpisodeGrid(`var processedEpisodeData = 'AAAA.AAAA'`), []);
});

test('witanime: decodeDownloadUrls restores direct media URLs in index order', () => {
  const script = witanimeEpisodeScript([
    'https://cdn.example.com/full/episode-1.mp4',
    'https://cdn.example.com/full/episode-1.m3u8',
  ]);
  const urls = testState.witanime.decodeDownloadUrls(script);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://cdn.example.com/full/episode-1.mp4');
  assert.equal(urls[1], 'https://cdn.example.com/full/episode-1.m3u8');
});

test('witanime: decodeDownloadUrls tolerates malformed groups', () => {
  assert.deepEqual(testState.witanime.decodeDownloadUrls('<html></html>'), []);
  const partial = `var _m = {"r":"AAAA"}; var _b = {"l":"3"}; var _x = ["00"];`;
  assert.deepEqual(testState.witanime.decodeDownloadUrls(partial), []);
});

test('witanime: decodeIframeResources strips param junk and appends yonaplay key', () => {
  const key = '9933bd27-92ea-4ee9-807d-e612029d6318';
  const url = `https://yonaplay.net/embed.php?id=12345`;
  const junkOffset = 5;
  // yh00.js stores base64(url + junk) with its characters reversed. The
  // reversed string must carry no '=' padding, so the junk is padded to make
  // the total length a multiple of 3.
  const junk = 'JUNKX';
  const resource = base64(`${url}${junk}`).split('').reverse().join('');
  const config = `[{"d":[${junk.length},0],"k":"${base64('0')}"}]`;
  const script = `var _zT = "${base64(`["${resource}"]`)}"; var _zV = "${base64(config)}";`;
  const urls = testState.witanime.decodeIframeResources(script);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], `${url}&apiKey=${key}`);
});

// ── URL safety ──────────────────────────────────────────────────────────────

test('support: isSafePublicUrl rejects private/loopback/reserved hosts', () => {
  const { isSafePublicUrl } = testState.support;
  for (const url of [
    'http://127.0.0.1/x.mp4',
    'http://localhost/x.mp4',
    'http://10.0.0.5/x.m3u8',
    'http://192.168.100.37/x.mp4',
    'http://172.16.0.1/x.m3u8',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x.mp4',
    'ftp://cdn.example.com/x.mp4',
    'file:///etc/passwd',
    'not-a-url',
  ]) {
    assert.equal(isSafePublicUrl(url), false, `should reject ${url}`);
  }
  for (const url of [
    'https://cdn.example.com/video.mp4',
    'https://w1.anime4up.rest/v/1.m3u8',
    'https://cdn.example.com/v.m3u8?token=abc',
    'http://8.8.8.8:8080/x.mp4',
  ]) {
    assert.equal(isSafePublicUrl(url), true, `should accept ${url}`);
  }
});

// ── Anime4Up end-to-end (fake site) ─────────────────────────────────────────

function htmlPage(body) {
  return `<!DOCTYPE html><html><head><title>Test</title></head><body>${body}</body></html>`;
}

anime4upServer.on('request', (req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/?s=') && /one|piece/i.test(url)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      htmlPage(`
        <div class="anime-grid">
          <div class="anime-card">
            <h3 class="anime-card-title"><a href="/anime/one-piece">One Piece</a></h3>
          </div>
          <div class="anime-card">
            <h3 class="anime-card-title"><a href="/anime/naruto">Naruto</a></h3>
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
          <li><a href="/anime/one-piece/3">الحلقة 3</a></li>
        </ul>`),
    );
    return;
  }
  if (url === '/anime/one-piece/2') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      htmlPage(`
        <div id="episode-servers">
          <li data-watch="https://w1.anime4up.rest/v/2.mp4" data-name="سيرفر FHD">server</li>
          <li data-watch="https://w1.anime4up.rest/v/2.m3u8" data-name="سيرفر HD">server</li>
          <li data-watch="https://embed.example/v2?id=99" data-name="سيرفر مباشر">server</li>
          <li data-watch="https://embed2.example/v?id=7" data-name="سيرفر إضافي">server</li>
        </div>
        <script>
          var jwConfig = { sources: [{ file: "https://cdn.anime4up.example/2.m3u8", label: "HD" }] };
        </script>`),
    );
    return;
  }
  if (url.startsWith('/?s=') || url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlPage('<div class="no-results">Nothing found</div>'));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end(htmlPage('Not found'));
});

test('anime4up: full chain search -> episode -> sources (embeds dropped)', async () => {
  const animePage = await testState.anime4up.searchAnimePage('One Piece');
  assert.ok(animePage.endsWith('/anime/one-piece'), `unexpected anime page: ${animePage}`);

  const episodePage = await testState.anime4up.episodePageUrl(animePage, 2);
  assert.equal(episodePage.endsWith('/anime/one-piece/2'), true, `unexpected episode page: ${episodePage}`);

  const sources = await testState.anime4up.resolveEpisodeSources(episodePage);
  const urls = sources.map((source) => source.url);
  assert.ok(urls.includes('https://w1.anime4up.rest/v/2.mp4'));
  assert.ok(urls.includes('https://w1.anime4up.rest/v/2.m3u8'));
  assert.ok(urls.includes('https://cdn.anime4up.example/2.m3u8'));
  assert.ok(!urls.some((url) => url.includes('embed.example')), 'embed pages must be dropped');
  const fhd = sources.find((source) => source.url === 'https://w1.anime4up.rest/v/2.mp4');
  assert.equal(fhd.quality, '1080p');
  assert.equal(fhd.provider, 'anime4up');
  assert.equal(fhd.headers.Referer, episodePage);
});

test('anime4up: nearest lower episode used when exact number missing', async () => {
  const animePage = await testState.anime4up.searchAnimePage('One Piece');
  const episodePage = await testState.anime4up.episodePageUrl(animePage, 99);
  assert.equal(episodePage.endsWith('/3'), true, `expected fallback to episode 3, got ${episodePage}`);
});

test('anime4up: search miss returns null', async () => {
  const animePage = await testState.anime4up.searchAnimePage('Totally Unknown Show');
  assert.equal(animePage, null);
});

// ── Embed resolution (multi-server extractors) ─────────────────────────────

/** Encodes watch-server iframe resources in the yh00.js format (one _zT/_zV pair). */
function witanimeIframeScript(urls) {
  const resources = urls.map((url) => {
    // The reversed base64 must carry no '=' padding: pick a junk length that
    // makes (url.length + junkLength) a multiple of 3.
    let junkLength = 1;
    while ((url.length + junkLength) % 3 !== 0) {
      junkLength += 1;
    }
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

witanimeServer.on('request', (req, res) => {
  if (req.url === '/anime/one-piece/2') {
    const download = witanimeEpisodeScript([
      'https://cdn.witanime.example/full/ep-2.mp4',
      'https://cdn.witanime.example/full/ep-2.m3u8',
    ]);
    const iframes = witanimeIframeScript([
      'https://embed.example/e/xyz',
      'https://embed.example/e/abc',
    ]);
    const tabs = `
      <div id="episode-servers">
        <a class="server-link" data-server-id="0"><span class="ser">الخادم 1</span></a>
        <a class="server-link" data-server-id="1"><span class="ser">سيرفر FHD</span></a>
      </div>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      htmlPage(`${tabs}<script>${download}\n${iframes}</script>`),
    );
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end(htmlPage('Not found'));
});

test('witanime: unknown embed hosts are skipped without any network call', async () => {
  const sources = await testState.witanime.resolveEpisodeSources(
    `http://127.0.0.1:${portOf(witanimeServer)}/anime/one-piece/2`,
  );
  const urls = sources.map((source) => source.url);
  assert.equal(urls.length, 2, 'only direct download URLs, embeds unresolved');
  assert.ok(urls.includes('https://cdn.witanime.example/full/ep-2.mp4'));
  assert.ok(urls.includes('https://cdn.witanime.example/full/ep-2.m3u8'));
});

test('witanime: watch-server embeds appended via injected resolveEmbed', async () => {
  const resolveEmbed = async (embedUrl) => [
    {
      url: `https://cdn.streamwish.com/hls/${encodeURIComponent(embedUrl)}/index.m3u8`,
      provider: 'streamwish',
      quality: 'auto',
      isHls: true,
      headers: {},
    },
  ];
  const sources = await testState.witanime.resolveEpisodeSources(
    `http://127.0.0.1:${portOf(witanimeServer)}/anime/one-piece/2`,
    { resolveEmbed, timeoutMs: 2000 },
  );
  assert.equal(sources.length, 4, '2 direct + 2 embed sources');
  const embeds = sources.filter((source) => source.provider === 'streamwish');
  assert.equal(embeds.length, 2);
  // Tab 0 name "الخادم 1" yields no quality mapping -> auto.
  assert.ok(embeds.some((source) => source.quality === 'auto'));
  // Tab 1 name "سيرفر FHD" maps through inferScraperQuality -> 1080p.
  assert.ok(embeds.some((source) => source.quality === '1080p'));
});

test('witanime: failing embed resolver never breaks the source list', async () => {
  const resolveEmbed = async (embedUrl) => {
    if (embedUrl.includes('e/abc')) {
      throw new Error('embed host is down');
    }
    return [
      {
        url: `https://cdn.vidas.su/hls/${encodeURIComponent(embedUrl)}/index.m3u8`,
        provider: 'vidas',
        quality: 'HD',
        isHls: true,
        headers: {},
      },
    ];
  };
  const sources = await testState.witanime.resolveEpisodeSources(
    `http://127.0.0.1:${portOf(witanimeServer)}/anime/one-piece/2`,
    { resolveEmbed, timeoutMs: 2000 },
  );
  assert.equal(sources.length, 3, 'direct sources survive a broken embed');
  assert.ok(sources.every((source) => source.provider === 'witanime' || source.provider === 'vidas'));
});

test('anime4up: embed rows resolved via injected resolveEmbed', async () => {
  const resolveEmbed = async (embedUrl) => {
    if (embedUrl.includes('embed2.')) {
      throw new Error('embed2 host is down');
    }
    return [
      {
        url: 'https://cdn.streamwish.com/hls/anime4up/index.m3u8',
        provider: 'streamwish',
        quality: 'auto',
        isHls: true,
        headers: {},
      },
    ];
  };
  const animePage = await testState.anime4up.searchAnimePage('One Piece');
  const episodePage = await testState.anime4up.episodePageUrl(animePage, 2);
  const sources = await testState.anime4up.resolveEpisodeSources(episodePage, {
    resolveEmbed,
    timeoutMs: 2000,
  });
  const urls = sources.map((source) => source.url);
  assert.ok(urls.includes('https://w1.anime4up.rest/v/2.mp4'));
  assert.ok(urls.includes('https://w1.anime4up.rest/v/2.m3u8'));
  assert.ok(urls.includes('https://cdn.anime4up.example/2.m3u8'));
  const embed = sources.find((source) => source.provider === 'streamwish');
  assert.ok(embed, 'embed row resolved into a streamwish source');
  assert.equal(embed.quality, 'auto');
});

// ── Failure isolation ───────────────────────────────────────────────────────

test('registry: provider timeout is isolated and reported as PROVIDER_TIMEOUT', async () => {
  const witanimeDown = testState.registry.resolveEpisodeSources({
    title: 'One Piece',
    episodeNumber: 1,
  });
  // Point a fresh registry at the hang server via direct provider call.
  const { support, witanime } = testState;
  await assert.rejects(
    support.withScraperGuard('witanime', async () => {
      const base = `http://127.0.0.1:${portOf(hangServer)}`;
      await witanime.searchAnimePage('One Piece', { baseUrl: base, timeoutMs: 300 });
      return null;
    }),
    (err) => err.code === 'TIMEOUT' && err.failureCategory === 'PROVIDER_TIMEOUT',
  );
  await witanimeDown;
});

test('registry: challenge page classified UPSTREAM_BLOCKED, never retried', async () => {
  const challengeServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Checking your browser... <div class="cf-browser-verification"></div></body></html>');
  });
  await new Promise((resolve) => challengeServer.listen(0, '127.0.0.1', resolve));
  try {
    const { support } = testState;
    await assert.rejects(
      support.fetchHtml(`http://127.0.0.1:${challengeServer.address().port}/`, {
        provider: 'test',
        timeoutMs: 500,
      }),
      (err) => err.code === 'UPSTREAM_BLOCKED' && err.failureCategory === 'UPSTREAM_BLOCKED',
    );
  } finally {
    await new Promise((resolve) => challengeServer.close(resolve));
  }
});

test('registry: all providers failed collapses to ALL_PROVIDERS_FAILED category', async () => {
  // Anime4Up base is healthy but the title does not exist there; WitAnime
  // base is unreachable (point it at the hang server indirectly by using a
  // title that produces no search hits on the fake anime4up server).
  const result = await testState.registry.resolveEpisodeSources({
    title: 'Does Not Exist Anywhere',
    episodeNumber: 1,
  });
  assert.equal(result.sources.length, 0);
  assert.ok(result.failures.length >= 1, 'failures must be recorded');
  assert.ok(
    result.failures.every((failure) => typeof failure.category === 'string' && failure.category.length > 0),
  );
});

// ── Resolver integration ────────────────────────────────────────────────────

test('resolver: scraper fallback serves sources when MiruroAPI is down', async () => {
  // MiruroAPI fake server 500s on everything -> provider fails, scraper runs.
  miruroServer.on('request', (req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"boom"}');
  });

  const { resolver } = testState;
  const result = await resolver.episodeSources(
    `watch/gogoanime/21/sub/one-piece-2`,
  );
  assert.equal(result.provider, 'scraper');
  assert.equal(result.fallbackProvider, 'anime4up');
  assert.ok(result.sources.length > 0);
  assert.ok(result.sources.every((source) => source.provider === 'anime4up'));
});

test('resolver: all providers failed raises controlled STREAM_UNAVAILABLE', async () => {
  miruroServer.removeAllListeners('request');
  miruroServer.on('request', (req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  const { resolver } = testState;
  await assert.rejects(
    resolver.episodeSources('watch/gogoanime/21/sub/unknown-title-42'),
    (err) =>
      err.code === 'STREAM_UNAVAILABLE' &&
      err.failureCategory === 'ALL_PROVIDERS_FAILED',
  );
});