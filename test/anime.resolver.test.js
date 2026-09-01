import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';

// Configuration must be settled BEFORE the app modules are imported (ESM
// static imports are hoisted, so the resolver import is dynamic). The fake
// providers therefore listen first, then env + import happen.
const miruroServer = createServer(routeMiruro);
const jikanServer = createServer(routeJikan);

await new Promise((resolve) => miruroServer.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => jikanServer.listen(0, '127.0.0.1', resolve));

process.env.ANIME_API_BASE_URL = `http://127.0.0.1:${miruroServer.address().port}`;
process.env.ANIME_JIKAN_BASE_URL = `http://127.0.0.1:${jikanServer.address().port}`;
process.env.ANIME_MAX_ATTEMPTS = '1'; // keep tests fast; no retry noise
process.env.ANIME_PROVIDER_PRIORITY = 'kiwi,pewe,bee';

const { metadataCache } = await import('../src/anime/cache.js');
const { searchAnime, animeInfo, animeEpisodes, animeCatalog, episodeSources } = await import('../src/anime/resolver.js');
const { AnimeApiError, ERROR_CODES } = await import('../src/anime/errors.js');

// ── Fake provider state ─────────────────────────────────────────────────────

const state = {
  miruroUp: true,
  miruroSearchRows: [
    { id: 21, title: { romaji: 'Demon Slayer', english: 'Demon Slayer' }, coverImage: { large: 'https://img.example.com/21.jpg' } },
  ],
  jikanUp: true,
  miruroRequests: [],
  jikanRequests: [],
};

const EPISODES_PAYLOAD = {
  providers: {
    kiwi: {
      episodes: {
        sub: [{ id: 'watch/kiwi/21/sub/kip-1', number: 1, title: 'Ep 1' }],
        dub: [{ id: 'watch/kiwi/21/dub/kip-1', number: 1, title: 'Ep 1 (Dub)' }],
      },
    },
    pewe: {
      episodes: {
        sub: [{ id: 'watch/pewe/21/sub/pep-1', number: 1, title: 'Ep 1' }],
      },
    },
  },
};

function routeMiruro(req, res) {
  state.miruroRequests.push(req.url);
  const url = new URL(req.url, 'http://miruro.test');
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!state.miruroUp) {
    return send({ success: false, message: 'down' }, 503);
  }
  if (url.pathname === '/api/search') {
    return send({ success: true, results: { results: state.miruroSearchRows, pageInfo: {} } });
  }
  if (url.pathname === '/api/trending' || url.pathname === '/api/popular' || url.pathname === '/api/recent' || url.pathname === '/api/spotlight') {
    return send({ success: true, results: state.miruroSearchRows });
  }
  const infoMatch = url.pathname.match(/^\/api\/info\/(\d+)$/);
  if (infoMatch) {
    if (infoMatch[1] === '999') {
      return send({ success: false, message: 'No anime found' }, 404);
    }
    return send({ success: true, results: { id: Number(infoMatch[1]), title: { romaji: 'Demon Slayer' } } });
  }
  if (url.pathname === '/api/episodes/21') {
    return send({ success: true, results: EPISODES_PAYLOAD });
  }
  if (url.pathname === '/api/episodes/999') {
    return send({ success: true, results: { providers: {} } });
  }
  const watchMatch = url.pathname.match(/^\/api\/watch\/([^/]+)\/(\d+)\/(sub|dub)\/(.+)$/);
  if (watchMatch) {
    const [, provider] = watchMatch;
    if (provider === 'dead') {
      return send({ success: false, message: 'Provider not found' }, 404);
    }
    return send({
      success: true,
      results: {
        streams: [
          { url: `https://cdn.example.com/${provider}-1.m3u8?tok=1`, type: 'hls', label: '1080p' },
          { url: 'https://embed.example.com/player', type: 'embed' },
        ],
        subtitles: [{ file: `https://cdn.example.com/${provider}-1.vtt`, label: 'EN', lang: 'en' }],
      },
    });
  }
  return send({ success: false, message: 'not found' }, 404);
}

function routeJikan(req, res) {
  state.jikanRequests.push(req.url);
  const url = new URL(req.url, 'http://jikan.test');
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!state.jikanUp) {
    return send({ status: 503, message: 'down' }, 503);
  }
  if (url.pathname === '/anime') {
    return send({
      data: [
        {
          mal_id: 1,
          title: 'Frieren',
          images: { jpg: { image_url: 'j.jpg', large_image_url: 'j.jpg' } },
          type: 'TV',
        },
      ],
    });
  }
  const fullMatch = url.pathname.match(/^\/anime\/(\d+)\/full$/);
  if (fullMatch) {
    if (fullMatch[1] === '404') {
      return send({ message: 'not found' }, 404);
    }
    return send({ data: { mal_id: Number(fullMatch[1]), title: 'Frieren', images: { jpg: { image_url: 'j.jpg' } } } });
  }
  const episodesMatch = url.pathname.match(/^\/anime\/(\d+)\/episodes$/);
  if (episodesMatch) {
    return send({ data: [{ mal_id: 3, title: 'Ep 3' }] });
  }
  return send({ status: 404, message: 'not found' }, 404);
}

after(async () => {
  await new Promise((resolve) => miruroServer.close(resolve));
  await new Promise((resolve) => jikanServer.close(resolve));
});

beforeEach(() => {
  state.miruroUp = true;
  state.jikanUp = true;
  metadataCache.clear();
});

function assertCode(err, code) {
  assert.ok(err instanceof AnimeApiError, `expected AnimeApiError, got ${err?.constructor?.name}`);
  assert.equal(err.code, code);
}

// ── search ──────────────────────────────────────────────────────────────────

test('search: miruro results win when available', async () => {
  const rows = await searchAnime('demon slayer');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 21);
});

test('search: falls back to jikan when miruro is down', async () => {
  state.miruroUp = false;
  const rows = await searchAnime('frieren');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'jikan_1');
  assert.equal(rows[0].provider, 'jikan');
});

test('search: both providers down raises PROVIDER_UNAVAILABLE', async () => {
  state.miruroUp = false;
  state.jikanUp = false;
  await assert.rejects(() => searchAnime('x'), (err) => {
    assertCode(err, ERROR_CODES.PROVIDER_UNAVAILABLE);
    return true;
  });
});

test('search: empty query is INVALID_REQUEST', async () => {
  await assert.rejects(() => searchAnime('   '), (err) => {
    assertCode(err, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
});

test('search: results are cached (no second upstream hit)', async () => {
  state.miruroRequests.length = 0;
  await searchAnime('cached-query');
  await searchAnime('cached-query');
  const hits = state.miruroRequests.filter((p) => p.includes('/api/search')).length;
  assert.equal(hits, 1);
});

// ── info ────────────────────────────────────────────────────────────────────

test('info: numeric ids resolve through miruro', async () => {
  const info = await animeInfo('21');
  assert.equal(info.id, 21);
});

test('info: jikan_ ids resolve through jikan', async () => {
  const info = await animeInfo('jikan_1');
  assert.equal(info.id, 'jikan_1');
});

test('info: unsupported id format is INVALID_REQUEST', async () => {
  await assert.rejects(() => animeInfo('watch/kiwi/21/sub/slug'), (err) => {
    assertCode(err, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
});

test('info: missing anime raises ANIME_NOT_FOUND', async () => {
  await assert.rejects(() => animeInfo('999'), (err) => {
    assertCode(err, ERROR_CODES.ANIME_NOT_FOUND);
    return true;
  });
});

// ── episodes ────────────────────────────────────────────────────────────────

test('episodes: keeps sub and dub variants, provider priority wins, resolvable flagged', async () => {
  const { episodes, providers } = await animeEpisodes('21');
  assert.equal(episodes.length, 2, 'one entry per (number, language)');
  const sub = episodes.find((ep) => ep.audio === 'sub');
  const dub = episodes.find((ep) => ep.audio === 'dub');
  assert.equal(sub.number, 1);
  assert.equal(sub.provider, 'kiwi', 'priority provider wins');
  assert.equal(sub.resolvable, true);
  assert.equal(dub.provider, 'kiwi');
  assert.equal(dub.resolvable, true);
  assert.deepEqual(providers, ['kiwi', 'pewe']);
});

test('episodes: no episodes raises EPISODE_NOT_FOUND', async () => {
  await assert.rejects(() => animeEpisodes('999'), (err) => {
    assertCode(err, ERROR_CODES.EPISODE_NOT_FOUND);
    return true;
  });
});

test('episodes: jikan_ ids return metadata episodes flagged non-resolvable', async () => {
  const { episodes } = await animeEpisodes('jikan_1');
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].resolvable, false);
  assert.equal(episodes[0].provider, 'jikan');
});

// ── catalog ─────────────────────────────────────────────────────────────────

test('catalog: allowed kinds return rows; invalid kind is INVALID_REQUEST', async () => {
  const trending = await animeCatalog('trending');
  assert.equal(trending.length, 1);
  await assert.rejects(() => animeCatalog('weird'), (err) => {
    assertCode(err, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
});

test('catalog: provider failure degrades to empty list, not an error', async () => {
  state.miruroUp = false;
  const rows = await animeCatalog('popular');
  assert.deepEqual(rows, []);
});

// ── sources (fallback chain) ────────────────────────────────────────────────

test('sources: requested provider works', async () => {
  const { sources, provider } = await episodeSources('watch/kiwi/21/sub/kip-1');
  assert.equal(provider, 'miruro');
  assert.equal(sources.length, 2, 'embed sources are now allowed');
  assert.equal(sources[0].url, 'https://cdn.example.com/kiwi-1.m3u8?tok=1');
  assert.equal(sources[0].isEmbed, false);
  assert.equal(sources[1].url, 'https://embed.example.com/player');
  assert.equal(sources[1].isEmbed, true);
  assert.equal(sources[0].provider, 'kiwi');
  assert.equal(sources[0].language, 'sub');
  assert.equal(sources[0].subtitles.length, 1);
});

test('sources: primary failure falls back to same-number episode on another provider', async () => {
  const { sources, fallbackProvider } = await episodeSources('watch/dead/21/sub/xxx-1');
  assert.equal(fallbackProvider, 'kiwi');
  assert.equal(sources[0].url, 'https://cdn.example.com/kiwi-1.m3u8?tok=1');
});

test('sources: fallback preserves language (dub stays dub)', async () => {
  const { sources } = await episodeSources('watch/dead/21/dub/xxx-1');
  assert.equal(sources[0].language, 'dub');
  assert.equal(sources[0].url, 'https://cdn.example.com/kiwi-1.m3u8?tok=1');
});

test('sources: all providers failing raises STREAM_UNAVAILABLE', async () => {
  state.miruroRequests.length = 0;
  await assert.rejects(() => episodeSources('watch/dead/999/sub/xxx-1'), (err) => {
    assertCode(err, ERROR_CODES.STREAM_UNAVAILABLE);
    return true;
  });
});

test('sources: malformed episode id is INVALID_REQUEST', async () => {
  await assert.rejects(() => episodeSources('not-a-watch-id'), (err) => {
    assertCode(err, ERROR_CODES.INVALID_REQUEST);
    return true;
  });
});