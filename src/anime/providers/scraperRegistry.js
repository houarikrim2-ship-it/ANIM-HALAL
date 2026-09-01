/**
 * Scraper fallback registry.
 *
 * Runs the HTML scraper providers in priority order after MiruroAPI fails,
 * and isolates every failure so one broken site never blocks the chain.
 *
 * Failure isolation contract (structured categories, never leaked raw):
 * - PROVIDER_TIMEOUT      request exceeded the bounded timeout
 * - PROVIDER_UNAVAILABLE  HTTP 5xx / network failure / non-HTML response
 * - UPSTREAM_BLOCKED      anti-bot challenge, HTTP 4xx, oversized page
 * - SOURCE_NOT_FOUND      page reached but no matching episode / media rows
 * - EXTRACTION_FAILED     payload present but malformed / undecodable
 * - ALL_PROVIDERS_FAILED  every scraper in the priority list failed
 *
 * Providers never solve CAPTCHAs or bypass anti-bot protection; challenge
 * pages are classified UPSTREAM_BLOCKED and skipped.
 */
import {
  ANIME_ANIME4UP_BASE_URL,
  ANIME_SCRAPER_ENABLED,
  ANIME_SCRAPER_PRIORITY,
  ANIME_SCRAPER_TIMEOUT_MS,
  ANIME_WITANIME_BASE_URL,
} from '../config.js';
import * as anime4up from './anime4upScraper.js';
import * as witanime from './witanimeScraper.js';

const PROVIDER_MODULES = {
  witanime,
  anime4up,
};

const PROVIDER_BASE_URLS = {
  witanime: ANIME_WITANIME_BASE_URL,
  anime4up: ANIME_ANIME4UP_BASE_URL,
};

function orderedProviders() {
  const order = ANIME_SCRAPER_PRIORITY.length > 0
    ? ANIME_SCRAPER_PRIORITY
    : ['witanime', 'anime4up'];
  return order
    .map((id) => {
      const module = PROVIDER_MODULES[id];
      if (!module) {
        return null;
      }
      return {
        id,
        name: module.NAME,
        searchAnimePage: module.searchAnimePage,
        episodePageUrl: module.episodePageUrl,
        resolveEpisodeSources: module.resolveEpisodeSources,
        catalog: module.catalog,
        info: module.info
      };
    })
    .filter((entry) => entry !== null);
}

/**
 * Resolves catalog rows from scraper providers.
 */
export async function resolveCatalog(kind, { page = 1 } = {}) {
    const results = [];
    const seenIds = new Set();

    for (const provider of orderedProviders()) {
        if (typeof provider.catalog !== 'function') continue;
        try {
            const rows = await provider.catalog(kind, { page });
            rows.forEach(r => {
                const globalId = `scraper:${provider.id}:${r.id}`;
                if (!seenIds.has(globalId)) {
                    seenIds.add(globalId);
                    results.push({ ...r, id: globalId });
                }
            });
        } catch (e) {
            console.warn(`[ScraperRegistry] catalog failed for ${provider.id}: ${e.message}`);
        }
    }

    return { results };
}

/**
 * Attempts every scraper provider for the given anime and aggregates every
 * viable source across providers. Each provider is isolated and parallelized
 * so a broken site never blocks the chain or causes total timeout.
 *
 * @param {object} params
 *   title        anime title to search for
 *   episodeNumber target episode number
 *   language     'sub' | 'dub' (scrapers surface the site's primary audio)
 * @returns {{ sources: Array, provider: string|null, failures: Array }}
 *   `provider` is the first (highest-priority) provider that yielded sources.
 */
export async function resolveEpisodeSources({ title, episodeNumber, language = 'sub', requestId = 'N/A' } = {}) {
  if (!ANIME_SCRAPER_ENABLED) {
    return { sources: [], provider: null, failures: [] };
  }
  const collected = [];
  const seenUrls = new Set();
  let firstProvider = null;

  const pushSources = (providerId, sources) => {
    if (firstProvider === null) firstProvider = providerId;
    for (const source of sources) {
      if (seenUrls.has(source.url)) continue;
      seenUrls.add(source.url);
      collected.push(source);
    }
  };

  const providers = orderedProviders();
  const results = await Promise.allSettled(providers.map(async (provider) => {
      try {
          const animePageUrl = await provider.searchAnimePage(title, {
              timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
              baseUrl: PROVIDER_BASE_URLS[provider.id],
          });
          if (animePageUrl === null) return { provider: provider.id, sources: [], failure: { step: 'search', category: 'SOURCE_NOT_FOUND', message: 'No matching anime page' } };

          const pageUrl = await provider.episodePageUrl(animePageUrl, episodeNumber, {
              timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
          });
          if (pageUrl === null) return { provider: provider.id, sources: [], failure: { step: 'episodePage', category: 'SOURCE_NOT_FOUND', message: `Episode ${episodeNumber} not found` } };

          const sources = await provider.resolveEpisodeSources(pageUrl, {
              timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
          });

          return { provider: provider.id, sources };
      } catch (err) {
          return {
              provider: provider.id,
              sources: [],
              failure: {
                  step: 'any',
                  category: err?.failureCategory ?? err?.code ?? 'EXTRACTION_FAILED',
                  message: sanitizeFailureMessage(err)
              }
          };
      }
  }));

  const failures = [];
  results.forEach(res => {
      if (res.status === 'fulfilled') {
          if (res.value.sources.length > 0) {
              pushSources(res.value.provider, res.value.sources);
          } else if (res.value.failure) {
              failures.push({ provider: res.value.provider, ...res.value.failure });
          }
      } else {
          failures.push({ provider: 'unknown', category: 'EXTRACTION_CRASH', message: res.reason?.message });
      }
  });

  if (collected.length > 0) {
    return {
      sources: collected,
      provider: firstProvider,
      failures: failures.length > 0 ? failures : null,
    };
  }
  return { sources: [], provider: null, failures };
}

/** Short, structured failure message for logging (never raw internals). */
function sanitizeFailureMessage(err) {
  if (err instanceof Error && typeof err.message === 'string') {
    return err.message.slice(0, 200);
  }
  return 'Unknown scraper failure';
}
