/**
 * Source-resolution orchestrator.
 *
 * Provider fallback rules:
 * - Every provider is queried independently; one failure never blocks the next.
 * - Fallback preserves anime identity and episode identity: the same AniList
 *   id, the same episode number and the same sub/dub language preference are
 *   always carried across providers.
 * - When every provider fails, a controlled [AnimeApiError] is raised with a
 *   stable code — never a raw provider exception.
 *
 * Metadata (search/info/episodes) is cached with TTLs. Stream sources are
 * never cached because media URLs expire.
 */
import { metadataCache } from './cache.js';
import {
  ANIME_EPISODES_CACHE_TTL_MS,
  ANIME_INFO_CACHE_TTL_MS,
  ANIME_JIKAN_ENABLED,
  ANIME_PROVIDER_ENABLED,
  ANIME_PROVIDER_PRIORITY,
  ANIME_SCRAPER_ENABLED,
  ANIME_SEARCH_CACHE_TTL_MS,
  ANIME_CATALOG_REFRESH_INTERVAL_MS,
} from './config.js';
import {
  AnimeApiError,
  ERROR_CODES,
  toApiError,
} from './errors.js';
import { logProviderEvent } from './logger.js';
import * as miruro from './providers/miruroProvider.js';
import * as jikan from './providers/jikanProvider.js';
import * as scraperRegistry from './providers/scraperRegistry.js';
import { parseWatchEpisodeId, finalizeSources } from './normalize.js';

const ALLOWED_IDS = /^(?:\d+|jikan_\d+|anilist:\d+)$/i;

function normalizeId(id) {
  return String(id ?? '').trim().replace(/^anilist:/i, '');
}

function isNumericId(id) {
  return /^\d+$/.test(id);
}

function isJikanId(id) {
  return /^jikan_\d+$/.test(id);
}

function log(provider, requestType, fields = {}) {
  logProviderEvent({ provider, requestType, ...fields });
}

/** [miruro, jikan] in priority order, honouring the enabled flags. */
function enabledProviders() {
  const list = [];
  if (ANIME_PROVIDER_ENABLED) list.push(miruro);
  if (ANIME_JIKAN_ENABLED) list.push(jikan);
  return list;
}

function searchProviders() {
  const list = enabledProviders();
  // Miruro is the only source-capable provider; the rest are metadata only.
  return list;
}

const ALLOWED_CATALOG_KINDS = new Set(['trending', 'popular', 'recent', 'spotlight']);

/**
 * Global catalog state. [revision] increments whenever any catalog row
 * data content changes across any provider.
 */
let catalogRevision = 1000;
let lastCatalogRefreshAt = 0;
let isRefreshing = false;

/** Returns the current catalog metadata state. */
export function getCatalogState() {
  return {
    revision: catalogRevision,
    lastUpdated: new Date(lastCatalogRefreshAt).toISOString(),
    refreshIntervalMs: ANIME_CATALOG_REFRESH_INTERVAL_MS,
    isRefreshing
  };
}

async function refreshCatalogTask() {
  if (isRefreshing) return;
  isRefreshing = true;
  console.log('[Resolver] CATALOG_REFRESH_START');

  let changed = false;
  for (const kind of ALLOWED_CATALOG_KINDS) {
    try {
      const cacheKey = `catalog:${kind}`;
      const oldRows = metadataCache.get(cacheKey) || [];

      let newRows = [];
      try {
          newRows = await miruro.catalog(kind);
      } catch (miruroErr) {
          console.warn(`[Resolver] MIRURO_CATALOG_FAILED kind=${kind}, falling back to scrapers...`);
          // Fallback to scrapers for trending/popular
          const scraperResult = await scraperRegistry.resolveCatalog(kind);
          newRows = scraperResult.results;
      }

      // Deep comparison of IDs to see if the list content changed
      const oldIds = oldRows.map(r => r.id).join(',');
      const newIds = newRows.map(r => r.id).join(',');

      if (newIds !== oldIds && newRows.length > 0) {
        console.log(`[Resolver] CATALOG_REVISION_CHANGED kind=${kind} count=${newRows.length}`);
        metadataCache.set(cacheKey, newRows, ANIME_SEARCH_CACHE_TTL_MS * 10); // Keep longer
        changed = true;
      }
    } catch (err) {
      console.warn(`[Resolver] CATALOG_REFRESH_FAILED kind=${kind} error=${err.message}`);
    }
  }

  if (changed) {
    catalogRevision++;
    console.log(`[Resolver] CATALOG_REFRESH_FINISHED revision=${catalogRevision}`);
  } else {
    console.log('[Resolver] CATALOG_REFRESH_NO_CHANGES');
  }

  lastCatalogRefreshAt = Date.now();
  isRefreshing = false;
}

// Start the background refresh loop if enabled
if (ANIME_CATALOG_REFRESH_INTERVAL_MS > 0 && typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
    setInterval(refreshCatalogTask, ANIME_CATALOG_REFRESH_INTERVAL_MS);
    // Initial immediate refresh
    setTimeout(refreshCatalogTask, 5000);
}

/**
 * Home-screen catalog rows. Miruro owns all catalog kinds; a failure returns
 * an empty list (catalog is non-critical) instead of failing the request.
 */
export async function animeCatalog(kind) {
  const normalized = String(kind ?? '').toLowerCase();
  if (!ALLOWED_CATALOG_KINDS.has(normalized)) {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'Unsupported catalog kind');
  }
  if (!ANIME_PROVIDER_ENABLED) {
    return [];
  }
  const cacheKey = `catalog:${normalized}`;
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const startedAt = Date.now();
  try {
    const rows = await miruro.catalog(normalized);
    const latencyMs = Date.now() - startedAt;
    log(miruro.providerInfo.name, 'catalog', { status: 200, latencyMs });
    metadataCache.set(cacheKey, rows, ANIME_SEARCH_CACHE_TTL_MS);
    return rows;
  } catch (err) {
    const apiError = toApiError(err, { provider: miruro.providerInfo.name });
    log(miruro.providerInfo.name, 'catalog', {
      status: apiError.status,
      latencyMs: Date.now() - startedAt,
      failureCategory: apiError.code,
    });
    return [];
  }
}

/**
 * Search across providers. The first provider that returns a non-empty list
 * wins; failures are logged and isolated so a down provider degrades to the
 * next one instead of failing the request.
 */
export async function searchAnime(queryText) {
  const query = String(queryText ?? '').trim();
  if (query === '') {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'Search query is required');
  }
  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const failures = [];
  let results = null;
  for (const provider of searchProviders()) {
    const startedAt = Date.now();
    try {
      const rows = await provider.search(query);
      log(provider.providerInfo.name, 'search', { animeId: null, status: 200, latencyMs: Date.now() - startedAt });
      if (rows.length > 0) {
        results = rows;
        break;
      }
      failures.push({ provider: provider.providerInfo.name, reason: 'empty' });
      log(provider.providerInfo.name, 'search', {
        status: 200,
        latencyMs: Date.now() - startedAt,
        failureCategory: 'EMPTY_RESULTS',
      });
    } catch (err) {
      const apiError = toApiError(err, { provider: provider.providerInfo.name });
      failures.push({ provider: provider.providerInfo.name, reason: apiError.code });
      log(provider.providerInfo.name, 'search', {
        status: apiError.status,
        latencyMs: Date.now() - startedAt,
        failureCategory: apiError.code,
      });
    }
  }

  if (results === null) {
    const first = failures[0];
    if (first !== undefined) {
      throw new AnimeApiError(
        first.reason === ERROR_CODES.ANIME_NOT_FOUND ? ERROR_CODES.ANIME_NOT_FOUND : ERROR_CODES.PROVIDER_UNAVAILABLE,
        `Search failed on all providers (${failures.map((f) => f.provider).join(', ')})`,
        { provider: first.provider }
      );
    }
    throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'No anime provider is enabled');
  }

  metadataCache.set(cacheKey, results, ANIME_SEARCH_CACHE_TTL_MS);
  return results;
}

/**
 * Full anime metadata. Miruro owns numeric (AniList) ids; Jikan owns
 * "jikan_<malId>" ids. Each provider self-filters its namespace, so a
 * fallback never returns a different anime.
 */
export async function animeInfo(id) {
  const raw = normalizeId(id);
  if (!ALLOWED_IDS.test(raw)) {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'Unsupported anime id format');
  }
  const cacheKey = `info:${raw}`;
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let target = null;
  if (isNumericId(raw) && ANIME_PROVIDER_ENABLED) {
    target = miruro;
  } else if (isJikanId(raw) && ANIME_JIKAN_ENABLED) {
    target = jikan;
  }

  if (target === null) {
    throw new AnimeApiError(
      ANIME_PROVIDER_ENABLED ? ERROR_CODES.ANIME_NOT_FOUND : ERROR_CODES.PROVIDER_UNAVAILABLE,
      'No enabled provider owns this anime id'
    );
  }

  const startedAt = Date.now();
  try {
    const info = isJikanId(raw)
      ? await target.info(Number(raw.replace('jikan_', '')))
      : await target.info(raw);
    const latencyMs = Date.now() - startedAt;
    if (info === null || info === undefined) {
      log(target.providerInfo.name, 'info', { animeId: raw, status: 404, latencyMs, failureCategory: ERROR_CODES.ANIME_NOT_FOUND });
      throw new AnimeApiError(ERROR_CODES.ANIME_NOT_FOUND, 'The requested anime was not found', { provider: target.providerInfo.name });
    }
    log(target.providerInfo.name, 'info', { animeId: raw, status: 200, latencyMs });
    metadataCache.set(cacheKey, info, ANIME_INFO_CACHE_TTL_MS);
    return info;
  } catch (err) {
    throw toApiError(err, { provider: target.providerInfo.name });
  }
}

/**
 * Episode list for an anime.
 *
 * Numeric (AniList) ids resolve through MiruroAPI; only episodes with a
 * resolvable source id are returned. "jikan_*" ids return Jikan's metadata
 * episodes (never resolvable, marked accordingly). Failures on all providers
 * raise [EPISODE_NOT_FOUND] / [PROVIDER_UNAVAILABLE].
 */
export async function animeEpisodes(id) {
  const raw = normalizeId(id);
  if (!ALLOWED_IDS.test(raw)) {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'Unsupported anime id format');
  }
  const cacheKey = `episodes:${raw}`;
  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (isJikanId(raw)) {
    if (!ANIME_JIKAN_ENABLED) {
      throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'Jikan provider is disabled');
    }
    const malId = Number(raw.replace('jikan_', ''));
    const startedAt = Date.now();
    const episodes = await jikan.episodes(raw, malId);
    log(jikan.providerInfo.name, 'episodes', { animeId: raw, status: 200, latencyMs: Date.now() - startedAt });
    const result = { episodes, providers: ['jikan'], total: episodes.length };
    metadataCache.set(cacheKey, result, ANIME_EPISODES_CACHE_TTL_MS);
    return result;
  }

  if (!ANIME_PROVIDER_ENABLED) {
    throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'Miruro provider is disabled');
  }

  const startedAt = Date.now();
  try {
    const payload = await miruro.episodes(raw);
    const { episodes, providers } = miruro.normalizeEpisodesPayload(payload, ANIME_PROVIDER_PRIORITY);
    const latencyMs = Date.now() - startedAt;
    if (episodes.length === 0) {
      log(miruro.providerInfo.name, 'episodes', { animeId: raw, status: 404, latencyMs, failureCategory: ERROR_CODES.EPISODE_NOT_FOUND });
      throw new AnimeApiError(ERROR_CODES.EPISODE_NOT_FOUND, 'No episodes were found for this anime', { provider: miruro.providerInfo.name });
    }
    log(miruro.providerInfo.name, 'episodes', { animeId: raw, status: 200, latencyMs });
    const result = { episodes, providers, total: episodes.length };
    metadataCache.set(cacheKey, result, ANIME_EPISODES_CACHE_TTL_MS);
    return result;
  } catch (err) {
    throw toApiError(err, { provider: miruro.providerInfo.name });
  }
}

/**
 * Resolves playable sources for one episode id.
 *
 * Strategy:
 * 1. Parse the opaque "watch/..." id (provider, anilistId, category, slug).
 * 2. Try the requested provider.
 * 3. On failure, fall back to every other Miruro provider that lists the
 *    SAME episode number + language — identity is preserved by construction.
 * 4. All failures raise a controlled [STREAM_UNAVAILABLE].
 *
 * Results are never cached (media URLs expire).
 */
export async function episodeSources(episodeId) {
  const raw = String(episodeId ?? '').trim();
  const parsed = parseWatchEpisodeId(raw);
  if (parsed === null) {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'Episode id must have the form watch/{provider}/{anilistId}/{category}/{slug}');
  }
  if (!ANIME_PROVIDER_ENABLED) {
    throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'Miruro provider is disabled');
  }

  const { provider, anilistId, category, slug } = parsed;

  console.log(`[Resolver] DISCOVERY_START episodeId=${raw} provider=${provider}`);

  // 1) Requested provider first.
  const primary = await attemptWatch(provider, raw);
  if (primary.sources.length > 0) {
    console.log(`[Resolver] DISCOVERY_SUCCESS source=PRIMARY provider=${provider} count=${primary.sources.length}`);
    return { provider: 'miruro', sources: finalizeSources(primary.sources) };
  }
  console.log(`[Resolver] PRIMARY_FAILED provider=${provider}`);
  log(miruro.providerInfo.name, 'sources', {
    animeId: anilistId,
    episodeId: raw,
    status: null,
    failureCategory: 'EMPTY_SOURCES',
    attemptedProviders: [provider],
  });

  // 2) Fallback: same anime, same episode number, same language.
  const slugNumberMatch = /-(\d+)$/.exec(slug);
  const slugNumber = slugNumberMatch !== null ? Number(slugNumberMatch[1]) : null;

  let episodeList = null;
  try {
    episodeList = await animeEpisodes(anilistId); // cached server-side
  } catch {
    episodeList = null;
  }

  // Miruro ids embed the episode number as the slug suffix ("{prefix}-{number}").
  // Match by id equality first, then by the number parsed from the slug, so
  // fallback also works when the requesting provider is absent from the list
  // or the episodes endpoint itself is unreachable.
  const listNumber = episodeList?.episodes.find((ep) => ep.id === raw)?.number;
  const targetNumber = listNumber ?? (slugNumber !== null ? slugNumber : null);
  if (episodeList !== null && targetNumber !== undefined) {
    const sameEpisode = episodeList.episodes.filter(
      (ep) => ep.number === targetNumber && ep.id !== raw
    );
    const attempted = [provider];
    for (const ep of sameEpisode) {
      const altParsed = parseWatchEpisodeId(ep.id);
      if (altParsed === null || altParsed.category !== category) {
        continue; // keep the sub/dub preference intact
      }
      if (attempted.includes(altParsed.provider)) {
        continue;
      }
      attempted.push(altParsed.provider);
      const alt = await attemptWatch(altParsed.provider, ep.id);
      if (alt.sources.length > 0) {
        console.log(`[Resolver] DISCOVERY_SUCCESS source=FALLBACK provider=${altParsed.provider} count=${alt.sources.length}`);
        log(miruro.providerInfo.name, 'sources', {
          animeId: anilistId,
          episodeId: raw,
          status: 200,
          failureCategory: 'FALLBACK_USED',
          fallbackProvider: altParsed.provider,
          attemptedProviders: attempted,
        });
        return { provider: 'miruro', sources: finalizeSources(alt.sources), fallbackProvider: altParsed.provider };
      }
      console.log(`[Resolver] FALLBACK_FAILED provider=${altParsed.provider}`);
      log(miruro.providerInfo.name, 'sources', {
        animeId: anilistId,
        episodeId: raw,
        status: null,
        failureCategory: 'EMPTY_SOURCES',
        attemptedProviders: attempted,
      });
    }
  }

  // 3) Scraper fallback (last resort): search the third-party sites by title
  //    and resolve the same episode number. Only direct media URLs come back;
  //    the relay re-validates hosts and re-checks them at playback time.
  if (scraperFallbackUsable(targetNumber)) {
    const title = scraperSearchTitle(anilistId, slug);
    if (title !== null) {
      console.log(`[Resolver] SCRAPER_DISCOVERY_START title="${title}" ep=${targetNumber}`);
      const scraped = await scraperRegistry.resolveEpisodeSources({
        title,
        episodeNumber: Number(targetNumber),
        language: category,
      });
      if (scraped.sources.length > 0) {
        console.log(`[Resolver] DISCOVERY_SUCCESS source=SCRAPER provider=${scraped.provider} count=${scraped.sources.length}`);
        log('scraper', 'sources', {
          animeId: anilistId,
          episodeId: raw,
          status: 200,
          failureCategory: 'SCRAPER_FALLBACK_USED',
          fallbackProvider: scraped.provider,
        });
        return {
          provider: 'scraper',
          sources: finalizeSources(scraped.sources),
          fallbackProvider: scraped.provider,
        };
      }
      console.log(`[Resolver] SCRAPER_FAILED providers=[${scraped.failures?.map(f => f.provider).join(', ')}]`);
      for (const failure of scraped.failures ?? []) {
        log('scraper', 'sources', {
          animeId: anilistId,
          episodeId: raw,
          status: null,
          failureCategory: failure.category ?? 'EXTRACTION_FAILED',
          providerAttempted: failure.provider,
          step: failure.step,
          message: failure.message,
        });
      }
    }
  }

  throw new AnimeApiError(
    ERROR_CODES.STREAM_UNAVAILABLE,
    'No playable source is currently available for this episode',
    { provider: miruro.providerInfo.name, failureCategory: 'ALL_PROVIDERS_FAILED' }
  );
}

/**
 * On-demand live extraction for an episode.
 *
 * Scans the third-party scraper providers in real-time. Unlike [episodeSources],
 * this NEVER checks MiruroAPI or Firestore: it is a pure, stateless extraction
 * path for the "free-as-possible" production tier.
 */
export async function extractSources({ anilistId, title: providedTitle, slug, episodeNumber, category = 'sub' }) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[Resolver][${requestId}] LIVE_EXTRACTION_START anilistId=${anilistId} ep=${episodeNumber}`);

  if (!anilistId || !episodeNumber) {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'anilistId and episodeNumber are required');
  }
  if (!ANIME_SCRAPER_ENABLED) {
    throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'Live extraction is disabled');
  }

  const normalizedId = normalizeId(anilistId);
  const targetNumber = Number(episodeNumber);

  let alternateTitles = [];
  try {
    const info = await animeInfo(normalizedId);
    if (info && info.title) {
      if (typeof info.title === 'object') {
        alternateTitles = [info.title.english, info.title.romaji, info.title.native].filter(Boolean);
      } else if (typeof info.title === 'string') {
        alternateTitles = [info.title];
      }
      if (info.englishTitle) alternateTitles.push(info.englishTitle);
      if (info.name) alternateTitles.push(info.name);
    }
    console.log(`[Resolver][${requestId}] TITLE_ENRICHMENT count=${alternateTitles.length}`);
  } catch (err) {
    console.warn(`[Resolver][${requestId}] TITLE_ENRICHMENT_FAILED: ${err.message}`);
  }

  const slugTitle = slug ? scraperSearchTitle(normalizedId, slug) : null;
  const titlesToTry = [...new Set([providedTitle, slugTitle, ...alternateTitles].filter(Boolean))];

  if (titlesToTry.length === 0) {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, 'Could not resolve anime title for extraction');
  }

  const startedAt = Date.now();
  let finalSources = [];
  let winningProvider = null;

  for (const title of titlesToTry) {
    console.log(`[Resolver][${requestId}] SCRAPER_TRY title="${title}"`);
    try {
        const scraped = await scraperRegistry.resolveEpisodeSources({
          title,
          episodeNumber: targetNumber,
          language: category,
          requestId,
        });

        if (scraped?.sources?.length > 0) {
          finalSources = scraped.sources;
          winningProvider = scraped.provider;
          console.log(`[Resolver][${requestId}] SCRAPER_HIT provider=${scraped.provider} direct=${scraped.sources.filter(s => !s.isEmbed).length} embed=${scraped.sources.filter(s => s.isEmbed).length}`);
          break;
        }
    } catch (e) {
        console.error(`[Resolver][${requestId}] SCRAPER_ERROR title="${title}": ${e.message}`);
    }
  }

  const latencyMs = Date.now() - startedAt;

  if (finalSources.length > 0) {
    const directCount = finalSources.filter(s => !s.isEmbed).length;
    console.log(`[Resolver][${requestId}] LIVE_EXTRACTION_SUCCESS direct=${directCount} embed=${finalSources.length - directCount}`);
    log('scraper', 'extract', { animeId: normalizedId, status: 200, latencyMs });
    return {
      provider: 'scraper',
      sources: finalizeSources(finalSources),
      fallbackProvider: winningProvider,
    };
  }

  console.error(`[Resolver][${requestId}] LIVE_EXTRACTION_FAILED reason=EMPTY_RESULTS titles=[${titlesToTry.join(', ')}]`);
  log('scraper', 'extract', {
    animeId: normalizedId,
    status: 404,
    latencyMs,
    failureCategory: 'EXTRACTION_EMPTY',
  });

  throw new AnimeApiError(
    ERROR_CODES.STREAM_UNAVAILABLE,
    `No playable source found for ${titlesToTry.join(' or ')}`,
    {
        failureCategory: 'EXTRACTION_EMPTY',
        retryable: true,
        failures: titlesToTry.map(t => ({ title: t, status: 'tried_but_empty' }))
    }
  );
}

/** Scrapers need a concrete episode number to resolve. */
function scraperFallbackUsable(targetNumber) {
  return (
    targetNumber !== null &&
    targetNumber !== undefined &&
    Number.isInteger(Number(targetNumber)) &&
    ANIME_SCRAPER_ENABLED
  );
}

/**
 * Search title for the scrapers. Sources, in order of preference:
 * 1. Cached anime info (from an earlier successful request — no network).
 * 2. The watch slug itself ("{title-slug}-{number}" → "one piece").
 *
 * Deliberately never performs a live provider call here: scrapers exist
 * precisely for the case where the MiruroAPI is unreachable, and the title
 * must resolve without it. Never throws.
 */
function scraperSearchTitle(anilistId, slug) {
  const cached = metadataCache.get(`info:${anilistId}`);
  if (cached !== undefined) {
    const title = pickSearchTitle(cached);
    if (title !== null) {
      return title;
    }
  }
  const slugTitle = String(slug ?? '')
    .replace(/-\d+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(?:ep|episode|watch)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return slugTitle === '' ? null : slugTitle;
}

/** Extracts the most searchable title from a provider info object. */
function pickSearchTitle(info) {
  if (info === null || typeof info !== 'object') {
    return null;
  }
  const candidates = [];
  if (typeof info.title === 'string') {
    candidates.push(info.title);
  } else if (info.title && typeof info.title === 'object') {
    candidates.push(info.title.english, info.title.romaji, info.title.native);
  }
  candidates.push(info.name, info.englishTitle);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return null;
}

async function attemptWatch(providerName, episodeId) {
  const startedAt = Date.now();
  try {
    const result = await miruro.watch(episodeId);
    log(miruro.providerInfo.name, 'sources', {
      animeId: result.parsed?.anilistId ?? null,
      episodeId,
      status: 200,
      latencyMs: Date.now() - startedAt,
      attemptedProviders: [providerName],
    });
    return result;
  } catch (err) {
    const apiError = toApiError(err, { provider: miruro.providerInfo.name });
    log(miruro.providerInfo.name, 'sources', {
      animeId: null,
      episodeId,
      status: apiError.status,
      latencyMs: Date.now() - startedAt,
      failureCategory: apiError.code,
      attemptedProviders: [providerName],
    });
    return { sources: [], provider: miruro.providerInfo.name, requestedProvider: providerName, parsed: null };
  }
}

/** Diagnostics: which providers are enabled and how the cache is sized. */
export function providerStatus() {
  return {
    providers: enabledProviders().map((p) => p.providerInfo),
    priority: ANIME_PROVIDER_PRIORITY,
    cache: {
      entries: metadataCache.size,
      maxEntries: Number(process.env.ANIME_CACHE_MAX_ENTRIES ?? 500),
    },
  };
}