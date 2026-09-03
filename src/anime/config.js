/**
 * Anime source-resolution configuration.
 *
 * All provider base URLs are environment-driven and validated as http(s)
 * URLs at startup. The backend NEVER fetches arbitrary client-supplied URLs:
 * the only upstream targets are the configured provider hosts below plus the
 * allowlisted media hosts used by the HLS relay (see ../config.js).
 */

const DEFAULT_ANIME_API_BASE_URL = 'https://mirurotvapi.vercel.app';
const DEFAULT_JIKAN_BASE_URL = 'https://api.jikan.moe/v4';

// MiruroAPI provider priority for episode deduplication and source fallback
// (the same provider ranking the Android client already uses).
const DEFAULT_PROVIDER_PRIORITY = Object.freeze([
  'kiwi', 'pewe', 'bee', 'bonk', 'bun', 'ally', 'nun', 'twin', 'cog', 'moo', 'hop', 'telli',
]);

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

function httpUrlEnv(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  const value = (raw || fallback).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: "${value}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${name}: only http(s) URLs are allowed, got "${value}"`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`Invalid ${name}: URL must not contain embedded credentials`);
  }
  return value;
}

export const ANIME_API_BASE_URL = httpUrlEnv('ANIME_API_BASE_URL', DEFAULT_ANIME_API_BASE_URL);
export const ANIME_JIKAN_BASE_URL = httpUrlEnv('ANIME_JIKAN_BASE_URL', DEFAULT_JIKAN_BASE_URL);

export const ANIME_PROVIDER_ENABLED = boolEnv('ANIME_PROVIDER_ENABLED', true);
export const ANIME_JIKAN_ENABLED = boolEnv('ANIME_JIKAN_ENABLED', true);

export const ANIME_PROVIDER_TIMEOUT_MS = intEnv('ANIME_PROVIDER_TIMEOUT_MS', 15000);
export const ANIME_MAX_ATTEMPTS = intEnv('ANIME_MAX_ATTEMPTS', 2);

export const ANIME_CACHE_MAX_ENTRIES = intEnv('ANIME_CACHE_MAX_ENTRIES', 500);
export const ANIME_SEARCH_CACHE_TTL_MS = intEnv('ANIME_SEARCH_CACHE_TTL_MS', 60_000);
export const ANIME_INFO_CACHE_TTL_MS = intEnv('ANIME_INFO_CACHE_TTL_MS', 300_000);
export const ANIME_EPISODES_CACHE_TTL_MS = intEnv('ANIME_EPISODES_CACHE_TTL_MS', 120_000);
// Stream sources are never cached: media URLs are often signed and expire.
export const ANIME_SOURCES_CACHE_TTL_MS = 0;

export const ANIME_CATALOG_REFRESH_INTERVAL_MS = intEnv('ANIME_CATALOG_REFRESH_INTERVAL_MS', 180_000); // 3 mins

export const ANIME_PROVIDER_PRIORITY = (() => {
  const raw = (process.env.ANIME_PROVIDER_PRIORITY ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return raw.length > 0 ? raw : DEFAULT_PROVIDER_PRIORITY;
})();

// ── HTML scraper providers (fallback chain, after MiruroAPI) ────────────────
// These are third-party mediators: the backend fetches provider pages with
// browser-like headers and extracts only directly playable media URLs. The
// Android client never contacts these hosts; every extracted URL is proxied
// through the HLS relay, which enforces the upstream allowlist.

const DEFAULT_WITANIME_BASE_URL = 'https://witanime.com';
const DEFAULT_ANIME4UP_BASE_URL = 'https://anime4up.rest';

export const ANIME_SCRAPER_ENABLED = true;

export const ANIME_WITANIME_BASE_URL = httpUrlEnv('ANIME_WITANIME_BASE_URL', DEFAULT_WITANIME_BASE_URL);
export const ANIME_ANIME4UP_BASE_URL = httpUrlEnv('ANIME_ANIME4UP_BASE_URL', DEFAULT_ANIME4UP_BASE_URL);

export const ANIME_SCRAPER_TIMEOUT_MS = intEnv('ANIME_SCRAPER_TIMEOUT_MS', 12000);

// ── Multi-server embed extractors (StreamWish / Vidas / YonaPlay) ──────────
// After a scraper page yields embed links, each embed is fetched once and
// parsed for direct media URLs. One failing host is omitted; it never breaks
// the whole source list. Extracted media URLs are validated and proxied
// through the HLS relay like every other source.
export const ANIME_EMBED_FOLLOW_ENABLED = true;
export const ANIME_EXTRACTOR_TIMEOUT_MS = intEnv('ANIME_EXTRACTOR_TIMEOUT_MS', 10000);

export const ANIME_SCRAPER_PRIORITY = (() => {
  const raw = (process.env.ANIME_SCRAPER_PRIORITY ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return raw.length > 0 ? raw : ['witanime', 'anime4up'];
})();

/** MiruroAPI episode ids look like: watch/{provider}/{anilistId}/{category}/{slug} */
export const WATCH_EPISODE_ID_PATTERN = /^watch\/([^/]+)\/(\d+)\/(sub|dub)\/(.+)$/i;

/** Direct-media URL suffix detection: .m3u8 / .mp4 / .webm / .m4v (with optional query/hash). */
export const DIRECT_MEDIA_URL_REGEX = /\.(m3u8|mp4|webm|m4v)([?#]|$)/i;

/** MIME type for the media type returned to clients. */
export const MEDIA_MIME_TYPES = Object.freeze({
  hls: 'application/vnd.apple.mpegurl',
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
});