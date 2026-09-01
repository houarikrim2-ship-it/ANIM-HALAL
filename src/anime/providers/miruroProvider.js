/**
 * MiruroAPI provider (primary).
 *
 * MiruroAPI (https://github.com/Shineii86/MiruroAPI, MIT) is a self-hostable,
 * documented REST API for anime metadata (AniList GraphQL) and streaming
 * sources. It is actively maintained and may be deployed by the operator
 * (ANIME_API_BASE_URL). It never requires authentication.
 *
 * Responses are normalized into the stable internal shapes in normalize.js.
 */
import { ANIME_API_BASE_URL, ANIME_PROVIDER_ENABLED, ANIME_PROVIDER_TIMEOUT_MS } from '../config.js';
import { fetchJson, withProviderGuard } from '../http.js';
import { normalizeMiruroEpisode, normalizeWatchSources, parseWatchEpisodeId } from '../normalize.js';

const NAME = 'miruro';

function query(params) {
  const search = new URLSearchParams(params);
  return `?${search.toString()}`;
}

export async function search(queryText, { perPage = 24, page = 1 } = {}) {
  return withProviderGuard(NAME, async () => {
    const { json } = await fetchJson(ANIME_API_BASE_URL, `/api/search${query({ query: queryText, page, per_page: perPage })}`, {
      provider: NAME,
      timeoutMs: ANIME_PROVIDER_TIMEOUT_MS,
    });
    const results = json?.results?.results ?? json?.results;
    return Array.isArray(results) ? results : [];
  });
}

export async function catalog(kind, { perPage = 24 } = {}) {
  const path = kind === 'spotlight' ? '/api/spotlight' : `/api/${kind}${query({ per_page: perPage })}`;
  return withProviderGuard(NAME, async () => {
    const { json } = await fetchJson(ANIME_API_BASE_URL, path, { provider: NAME, timeoutMs: ANIME_PROVIDER_TIMEOUT_MS });
    const results = Array.isArray(json?.results) ? json.results : json?.results?.results;
    return Array.isArray(results) ? results : [];
  });
}

export async function info(anilistId) {
  return withProviderGuard(NAME, async () => {
    console.log(`[Miruro] GET /api/info/${anilistId}`);
    const { json, status } = await fetchJson(ANIME_API_BASE_URL, `/api/info/${anilistId}`, { provider: NAME, timeoutMs: ANIME_PROVIDER_TIMEOUT_MS });
    console.log(`[Miruro] HTTP ${status} for /api/info/${anilistId}`);
    return json?.results ?? null;
  });
}

/**
 * Episode list for an AniList id. Returns the raw provider map
 * ({ providerName: { meta, episodes: { sub, dub } } }) for the resolver to
 * deduplicate and normalize.
 */
export async function episodes(anilistId) {
  return withProviderGuard(NAME, async () => {
    const { json } = await fetchJson(ANIME_API_BASE_URL, `/api/episodes/${anilistId}`, { provider: NAME, timeoutMs: ANIME_PROVIDER_TIMEOUT_MS });
    return json?.results ?? null;
  });
}

/**
 * Normalizes the raw /api/episodes/:id payload into a flat, deduplicated,
 * resolvable episode list. One episode per (number, language) pair: the
 * sub and dub variant of the same episode are both kept (clients choose the
 * language), each with its provider-priority winner.
 */
export function normalizeEpisodesPayload(payload, providerPriority = []) {
  const providers = payload?.providers;
  if (providers === null || typeof providers !== 'object') {
    return { episodes: [], providers: [] };
  }
  const providerNames = Object.keys(providers);
  const priority = [...providerPriority, ...providerNames.filter((p) => !providerPriority.includes(p))];

  const byKey = new Map();
  const chosenProvider = new Map();
  for (const providerName of priority) {
    const lists = providers[providerName]?.episodes;
    if (lists === null || typeof lists !== 'object') {
      continue;
    }
    for (const category of ['sub', 'dub']) {
      const candidates = Array.isArray(lists[category]) ? lists[category] : [];
      for (const ep of candidates) {
        const num = ep?.number;
        const key = `${num}:${category}`;
        if (num !== undefined && num !== null && !byKey.has(key)) {
          byKey.set(key, ep);
          chosenProvider.set(key, providerName);
        }
      }
    }
  }

  const episodes = [...byKey.entries()].map(([key, ep]) => {
    const category = key.split(':')[1];
    const normalized = normalizeMiruroEpisode({ ...ep, audio: ep.audio ?? category }, chosenProvider.get(key) ?? 'unknown');
    return normalized === null ? null : { ...normalized, number: ep.number };
  }).filter((ep) => ep !== null);

  return { episodes, providers: providerNames };
}

/**
 * Resolves playable sources for one episode.
 *
 * [episodeId] is the opaque "watch/{provider}/{anilistId}/{category}/{slug}"
 * id. Only direct media URLs are returned; embed/HTML sources are skipped.
 */
export async function watch(episodeId, options = {}) {
  const parsed = typeof episodeId === 'string' ? parseWatchEpisodeId(episodeId) : null;
  if (parsed === null) {
    return { sources: [], provider: NAME, requestedProvider: null, parsed: null };
  }
  const { provider, anilistId, category, slug } = parsed;
  const { timeoutMs = ANIME_PROVIDER_TIMEOUT_MS, retries = true } = options;

  return withProviderGuard(NAME, async () => {
    const { json } = await fetchJson(
      ANIME_API_BASE_URL,
      `/api/watch/${encodeURIComponent(provider)}/${anilistId}/${category}/${encodeURIComponent(slug)}`,
      {
        provider: NAME,
        timeoutMs,
        maxAttempts: retries ? undefined : 1,
      }
    );
    const watchResponse = json?.results ?? json;
    const language = category === 'dub' ? 'dub' : 'sub';
    const sources = normalizeWatchSources(watchResponse, { providerName: provider, language, baseUrl: ANIME_API_BASE_URL });
    return { sources, provider: NAME, requestedProvider: provider, parsed };
  });
}

export const providerInfo = {
  name: NAME,
  enabled: ANIME_PROVIDER_ENABLED,
  baseUrl: ANIME_API_BASE_URL,
  type: 'metadata+sources',
};