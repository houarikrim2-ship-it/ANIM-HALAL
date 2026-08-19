import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isDirectMediaUrl,
  normalizeJikanAnime,
  normalizeJikanEpisode,
  normalizeMiruroEpisode,
  normalizeStreamSource,
  normalizeSubtitle,
  normalizeUrl,
  normalizeWatchSources,
  parseWatchEpisodeId,
} from '../src/anime/normalize.js';

// ── normalizeUrl ────────────────────────────────────────────────────────────

test('normalizeUrl: absolute https URL passes through unchanged (signed URLs preserved)', () => {
  const signed = 'https://cdn.example.com/s1/master.m3u8?token=abc&expires=1700000000&sig=x%2By';
  assert.equal(normalizeUrl(signed), signed);
});

test('normalizeUrl: relative URL resolves against the base', () => {
  assert.equal(normalizeUrl('/segs/1.ts', 'https://cdn.example.com/a/b.m3u8'), 'https://cdn.example.com/segs/1.ts');
});

test('normalizeUrl: protocol-relative URL resolves to https', () => {
  assert.equal(normalizeUrl('//cdn.example.com/x.mp4', 'https://a.example.com/'), 'https://cdn.example.com/x.mp4');
});

test('normalizeUrl: non-http(s) and garbage inputs are rejected', () => {
  assert.equal(normalizeUrl('ftp://x.example.com/f.mp4', 'https://a.example.com/'), null);
  assert.equal(normalizeUrl('javascript:alert(1)', 'https://a.example.com/'), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl('   '), null);
  assert.equal(normalizeUrl(null), null);
});

test('normalizeUrl: relative URL without a base is rejected', () => {
  assert.equal(normalizeUrl('/x.m3u8'), null);
});

// ── isDirectMediaUrl ────────────────────────────────────────────────────────

test('isDirectMediaUrl: accepts playable media suffixes with query/hash', () => {
  assert.equal(isDirectMediaUrl('https://x.com/master.m3u8'), true);
  assert.equal(isDirectMediaUrl('https://x.com/master.m3u8?token=1'), true);
  assert.equal(isDirectMediaUrl('https://x.com/v.mp4'), true);
  assert.equal(isDirectMediaUrl('https://x.com/v.webm?q=1'), true);
  assert.equal(isDirectMediaUrl('https://x.com/v.m4v#frag'), true);
});

test('isDirectMediaUrl: rejects embed pages, HTML and opaque URLs', () => {
  assert.equal(isDirectMediaUrl('https://x.com/embed/abc123'), false);
  assert.equal(isDirectMediaUrl('https://x.com/player?id=1'), false);
  assert.equal(isDirectMediaUrl('https://x.com/watch/abc'), false);
});

// ── parseWatchEpisodeId ─────────────────────────────────────────────────────

test('parseWatchEpisodeId: parses the Miruro watch id shape', () => {
  const parsed = parseWatchEpisodeId('watch/kiwi/21/sub/demon-slayer-1');
  assert.deepEqual(parsed, { provider: 'kiwi', anilistId: '21', category: 'sub', slug: 'demon-slayer-1' });
  const dub = parseWatchEpisodeId('watch/bee/1429/dub/one-piece-1080');
  assert.equal(dub.category, 'dub');
  assert.equal(dub.anilistId, '1429');
});

test('parseWatchEpisodeId: rejects malformed ids', () => {
  assert.equal(parseWatchEpisodeId('not-a-watch-id'), null);
  assert.equal(parseWatchEpisodeId('watch/kiwi/21/dub'), null);
  assert.equal(parseWatchEpisodeId('watch/kiwi/abc/sub/slug'), null);
  assert.equal(parseWatchEpisodeId(''), null);
  assert.equal(parseWatchEpisodeId(null), null);
});

// ── normalizeStreamSource ───────────────────────────────────────────────────

test('normalizeStreamSource: HLS with headers and subtitles', () => {
  const source = normalizeStreamSource(
    {
      file: 'https://cdn.example.com/master.m3u8?tok=1',
      type: 'hls',
      label: '1080p',
      referer: 'https://source.example.com/',
      subtitles: [{ file: '/subs/en.vtt', label: 'English', lang: 'en' }],
    },
    { providerName: 'kiwi', language: 'sub', baseUrl: 'https://cdn.example.com' }
  );
  assert.deepEqual(source, {
    url: 'https://cdn.example.com/master.m3u8?tok=1',
    type: 'hls',
    quality: '1080p',
    mimeType: 'application/vnd.apple.mpegurl',
    isHls: true,
    headers: { Referer: 'https://source.example.com/' },
    subtitles: [
      {
        url: 'https://cdn.example.com/subs/en.vtt',
        label: 'English',
        language: 'en',
        mimeType: 'text/vtt',
      },
    ],
    provider: 'kiwi',
    language: 'sub',
  });
});

test('normalizeStreamSource: embed pages are rejected, never forwarded', () => {
  assert.equal(
    normalizeStreamSource({ file: 'https://embed.example.com/player?e=1', type: 'embed' }, { providerName: 'x' }),
    null
  );
  assert.equal(normalizeStreamSource({ url: 'https://x.com/watch/123' }, { providerName: 'x' }), null);
});

test('normalizeStreamSource: missing url yields null', () => {
  assert.equal(normalizeStreamSource({}, { providerName: 'x' }), null);
  assert.equal(normalizeStreamSource(null, { providerName: 'x' }), null);
});

test('normalizeStreamSource: progressive mp4 with origin header', () => {
  const source = normalizeStreamSource(
    { url: 'https://cdn.example.com/v.mp4', quality: '720p', origin: 'https://x.example.com' },
    { providerName: 'pewe', language: 'dub' }
  );
  assert.equal(source.type, 'progressive');
  assert.equal(source.isHls, false);
  assert.equal(source.mimeType, 'video/mp4');
  assert.equal(source.quality, '720p');
  assert.deepEqual(source.headers, { Origin: 'https://x.example.com' });
  assert.equal(source.language, 'dub');
});

// ── normalizeWatchSources ───────────────────────────────────────────────────

test('normalizeWatchSources: accepts both streams and sources keys, dedupes by url', () => {
  const viaStreams = normalizeWatchSources(
    {
      streams: [
        { url: 'https://cdn.example.com/a.m3u8', quality: '1080p' },
        { url: 'https://cdn.example.com/a.m3u8', quality: '1080p' },
        { url: 'https://embed.example.com/player', type: 'embed' },
      ],
    },
    { providerName: 'kiwi' }
  );
  assert.equal(viaStreams.length, 1);
  assert.equal(viaStreams[0].url, 'https://cdn.example.com/a.m3u8');

  const viaSources = normalizeWatchSources(
    {
      sources: [{ file: 'https://cdn.example.com/b.mp4', label: '720p' }],
      subtitles: [{ file: 'https://cdn.example.com/en.vtt', label: 'EN', lang: 'en' }],
    },
    { providerName: 'bonk' }
  );
  assert.equal(viaSources.length, 1);
  assert.equal(viaSources[0].quality, '720p');
  assert.equal(viaSources[0].subtitles[0].url, 'https://cdn.example.com/en.vtt');
});

// ── normalizeSubtitle ───────────────────────────────────────────────────────

test('normalizeSubtitle: resolves relative urls, defaults missing fields', () => {
  const sub = normalizeSubtitle({ url: '/s.vtt' }, 'https://cdn.example.com/x.m3u8');
  assert.equal(sub.url, 'https://cdn.example.com/s.vtt');
  assert.equal(sub.language, 'und');
});

// ── Episode normalization ───────────────────────────────────────────────────

test('normalizeMiruroEpisode: resolvable watch ids are flagged', () => {
  const ep = normalizeMiruroEpisode({ id: 'watch/kiwi/21/sub/slug-3', number: 3, title: 'Ep 3' }, 'kiwi');
  assert.equal(ep.resolvable, true);
  assert.equal(ep.audio, 'sub');
  assert.equal(ep.provider, 'kiwi');
});

test('normalizeMiruroEpisode: unparseable ids are flagged non-resolvable', () => {
  const ep = normalizeMiruroEpisode({ id: 'zzz-3', number: 3 }, 'kiwi');
  assert.equal(ep.resolvable, false);
  assert.equal(normalizeMiruroEpisode({ number: 3 }, 'kiwi'), null);
});

test('normalizeJikanEpisode: never resolvable (metadata only)', () => {
  const ep = normalizeJikanEpisode('jikan_1', { mal_id: 3, title: 'Ep 3', aired: '2024-01-01', filler: false });
  assert.equal(ep.resolvable, false);
  assert.equal(ep.id, 'jikan_1_s1_ep3');
  assert.equal(ep.provider, 'jikan');
});

test('normalizeJikanAnime: stable summary with jikan_ namespace id', () => {
  const anime = normalizeJikanAnime({
    mal_id: 123,
    title: 'Sousou no Frieren',
    title_english: 'Frieren',
    images: { jpg: { image_url: 'j.jpg', large_image_url: 'j-l.jpg' }, webp: { large_image_url: 'w-l.jpg' } },
    type: 'TV',
    episodes: 28,
    score: 9.1,
    members: 9000,
    genres: [{ name: 'Fantasy' }],
    synopsis: 'An elf mage...',
    studios: [{ name: 'Madhouse' }],
    aired: { prop: { from: { year: 2023, month: 9, day: 29 } } },
  });
  assert.equal(anime.id, 'jikan_123');
  assert.equal(anime.coverImage.large, 'w-l.jpg');
  assert.equal(anime.averageScore, 91);
  assert.equal(anime.genres[0], 'Fantasy');
  assert.equal(anime.provider, 'jikan');
  assert.equal(anime.isAdult, false);
});