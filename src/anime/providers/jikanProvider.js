/**
 * Jikan provider (metadata fallback).
 *
 * Jikan v4 (https://jikan.moe, documented, rate-limited to ~3 req/s, no
 * authentication) exposes MyAnimeList metadata: search, full info and
 * episode lists. It NEVER returns playable media URLs, so it participates in
 * metadata resolution only (search + info fallback).
 *
 * Responses are normalized to the same stable summary shape as MiruroAPI so
 * the Android client sees exactly one metadata contract.
 */
import { ANIME_JIKAN_BASE_URL, ANIME_JIKAN_ENABLED, ANIME_PROVIDER_TIMEOUT_MS } from '../config.js';
import { fetchJson, withProviderGuard } from '../http.js';
import { normalizeJikanAnime, normalizeJikanEpisode } from '../normalize.js';

const NAME = 'jikan';
const MIN_REQUEST_SPACING_MS = 350; // ~3 req/s per Jikan's fair-use guidance
let lastRequestAt = 0;

async function spaced() {
  const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

export async function search(queryText, { limit = 20 } = {}) {
  return withProviderGuard(NAME, async () => {
    await spaced();
    const { json } = await fetchJson(
      ANIME_JIKAN_BASE_URL,
      `/anime?q=${encodeURIComponent(queryText)}&limit=${limit}&sfw=true`,
      { provider: NAME, timeoutMs: ANIME_PROVIDER_TIMEOUT_MS }
    );
    return (json?.data ?? []).map(normalizeJikanAnime).filter((a) => a !== null);
  });
}

export async function info(malId) {
  return withProviderGuard(NAME, async () => {
    await spaced();
    const { json } = await fetchJson(ANIME_JIKAN_BASE_URL, `/anime/${malId}/full`, { provider: NAME, timeoutMs: ANIME_PROVIDER_TIMEOUT_MS });
    return normalizeJikanAnime(json?.data ?? null);
  });
}

export async function episodes(animeId, malId, { limit = 30 } = {}) {
  return withProviderGuard(NAME, async () => {
    await spaced();
    const { json } = await fetchJson(ANIME_JIKAN_BASE_URL, `/anime/${malId}/episodes?limit=${limit}`, { provider: NAME, timeoutMs: ANIME_PROVIDER_TIMEOUT_MS });
    return (json?.data ?? []).map((ep) => normalizeJikanEpisode(animeId, ep)).filter((ep) => ep !== null);
  });
}

/** Jikan is a metadata-only provider: it can never resolve playable sources. */
export async function fetchSources(_episodeId) {
  throw new Error('Jikan is a metadata-only provider and cannot resolve playable sources');
}

export const providerInfo = {
  name: NAME,
  enabled: ANIME_JIKAN_ENABLED,
  baseUrl: ANIME_JIKAN_BASE_URL,
  type: 'metadata',
};