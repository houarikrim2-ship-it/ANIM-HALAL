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
      };
    })
    .filter((entry) => entry !== null);
}

/**
 * Attempts every scraper provider in priority order for the given anime.
 *
 * @param {object} params
 *   title        anime title to search for
 *   episodeNumber target episode number
 *   language     'sub' | 'dub' (scrapers surface the site's primary audio)
 * @returns {{ sources: Array, provider: string|null, failures: Array }}
 *   `sources` is non-empty only when one provider succeeded.
 */
export async function resolveEpisodeSources({ title, episodeNumber, language = 'sub' } = {}) {
  if (!ANIME_SCRAPER_ENABLED) {
    return { sources: [], provider: null, failures: [] };
  }
  const failures = [];
  for (const provider of orderedProviders()) {
    const attempt = { provider: provider.id, step: 'search', category: null, message: null };
    try {
      const animePageUrl = await provider.searchAnimePage(title, {
        timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
        baseUrl: PROVIDER_BASE_URLS[provider.id],
      });
      if (animePageUrl === null) {
        attempt.category = 'SOURCE_NOT_FOUND';
        attempt.message = 'No matching anime page on search';
        failures.push(attempt);
        continue;
      }

      attempt.step = 'episodePage';
      const pageUrl = await provider.episodePageUrl(animePageUrl, episodeNumber, {
        timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
      });
      if (pageUrl === null) {
        attempt.category = 'SOURCE_NOT_FOUND';
        attempt.message = `Episode ${episodeNumber} not found on anime page`;
        failures.push(attempt);
        continue;
      }

      attempt.step = 'sources';
      const sources = await provider.resolveEpisodeSources(pageUrl, {
        timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
      });
      if (sources.length > 0) {
        return {
          sources,
          provider: provider.id,
          failures: failures.length > 0 ? failures : null,
        };
      }
      attempt.category = 'SOURCE_NOT_FOUND';
      attempt.message = 'Episode page contained no playable media';
      failures.push(attempt);
    } catch (err) {
      attempt.category = err?.failureCategory ?? err?.code ?? 'EXTRACTION_FAILED';
      attempt.message = sanitizeFailureMessage(err);
      failures.push(attempt);
    }
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