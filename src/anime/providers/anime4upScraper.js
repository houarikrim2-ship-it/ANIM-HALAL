/**
 * Anime4Up scraper provider (anime4up.rest / w1.anime4up.rest mirrors).
 *
 * WordPress Arabic streaming site. The anime page lists episodes as anchors
 * (`.episodesList .ep_num`, `ul.episodes li`, ...) whose URLs carry the
 * episode number; the watch page renders server rows inside containers such
 * as `#episode-servers` with `data-watch`/`data-src`/`data-video` attributes
 * and jwplayer-style `file`/`label` JSON inside scripts.
 *
 * Extraction rules (mirror the Android ArabicSiteAdapter):
 * - Server rows whose target is a directly playable media URL (.m3u8/.mp4/
 *   .webm/.m4v) become sources.
 * - Server rows whose target is an embed page are deliberately skipped: the
 *   backend never follows embed players or bypasses anti-bot protection.
 * - jwplayer `sources:[{file,label}]` entries are accepted when direct media.
 *
 * The relay re-validates every host at playback time against its allowlist.
 */
import { ANIME_ANIME4UP_BASE_URL, ANIME_SCRAPER_TIMEOUT_MS } from '../config.js';
import { AnimeApiError, ERROR_CODES } from '../errors.js';
import { normalizeStreamSource, normalizeUrl } from '../normalize.js';
import {
  decodeHtmlAttribute,
  fetchHtml,
  inferScraperQuality,
  isSafePublicUrl,
  withScraperGuard,
} from './scraperSupport.js';

export const NAME = 'anime4up';
export const PROVIDER_ID = 'anime4up';

const SERVER_CONTAINER_SELECTORS = [
  '#episode-servers',
  '.episodes-servers',
  '.watch-servers',
  '.servers-list',
  '.server-list',
  '.episodes-servers-list',
  '.player-servers',
  '.server-items',
  '#servers',
  '.download-links',
  '.downloads',
  '.server-links',
  '.watch-links',
];

const SERVER_ITEM_TAGS = '(?:button|li|a|div|span)';

const DATA_ATTRIBUTES = ['data-src', 'data-video', 'data-url', 'data-watch', 'data-embed', 'data-iframe'];

const EPISODE_LINK_PATTERNS = [
  /(?:episode|ep)[-_/]?(\d+)/i,
  /(?:الحلقة|حلقة)[-_/]?(\d+)/,
  /(?:الحلقة|حلقة|episode|ep)\s*[:：\-]?\s*(\d+)/i,
];

const GENERIC_TAIL_PATTERN = /\/(\d{1,4})\/?$/;

const SEARCH_LINK_PATTERNS = [
  /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  /<a[^>]+class="[^"]*(?:anime-card-title|post-title|anime-item|search-item|post-card)[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  /<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
];

const EPISODE_LINK_PATTERN = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

const PLAYER_SOURCES_REGEX = /sources\s*:\s*\[\s*\{([\s\S]*?)\}\s*\]/gi;
const FILE_LABEL_REGEX = /file\s*:\s*"([^"]+)"\s*,\s*label\s*:\s*"([^"]*)"/gi;
const LABEL_FILE_REGEX = /label\s*:\s*"([^"]*)"\s*,\s*file\s*:\s*"([^"]+)"/gi;
const BARE_FILE_REGEX = /file\s*:\s*"(https?:\/\/[^"]+\.(?:m3u8|mp4|webm|m4v)[^"]*)"\s*(?:,\s*(?:label|type)\s*:\s*"[^"]*")?/gi;

/** Searches the site and returns the most relevant anime page URL, or null. */
export async function searchAnimePage(title, options = {}) {
  return withScraperGuard(NAME, async () => {
    const query = String(title ?? '').trim();
    if (query === '') {
      return null;
    }
    const base = options.baseUrl ?? ANIME_ANIME4UP_BASE_URL;
    const searchUrl = `${base}/?s=${encodeURIComponent(query)}`;
    const { text, finalUrl } = await fetchHtml(searchUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    return pickBestResult(text, finalUrl, query);
  });
}

/**
 * Returns the episode page URL for [number] on the anime page, or null.
 * Exact match first, then the nearest lower-numbered episode.
 */
export async function episodePageUrl(animePageUrl, number, options = {}) {
  return withScraperGuard(NAME, async () => {
    const { text, finalUrl } = await fetchHtml(animePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const episodes = extractEpisodes(text, finalUrl);
    if (episodes.length === 0) {
      return null;
    }
    const target = Number(number);
    const exact = episodes.find((entry) => entry.number === target);
    const entry = exact ?? episodes
      .filter((candidate) => candidate.number <= target)
      .sort((a, b) => b.number - a.number)[0];
    return entry?.url ?? null;
  });
}

/**
 * Resolves playable media sources from an Anime4Up episode page.
 *
 * Direct media rows become sources immediately. Embed rows (StreamWish /
 * Vidas / YonaPlay players) are followed through the host extractor chain:
 * each embed is fetched with bounded timeouts and one failing host is
 * omitted — it never breaks the request. Only direct URLs survive
 * normalization (and later the relay allowlist).
 */
export async function resolveEpisodeSources(episodePageUrl, options = {}) {
  return withScraperGuard(NAME, async () => {
    const resolveEmbed = options.resolveEmbed ?? registryResolveEmbed;
    const { text, finalUrl } = await fetchHtml(episodePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const origin = new URL(finalUrl).origin;
    const candidates = extractServerRows(text, finalUrl);
    const scriptCandidates = extractPlayerFileEntries(text, finalUrl);

    const sources = [];
    const seenUrls = new Set();
    const embeds = [];
    for (const candidate of [...candidates, ...scriptCandidates]) {
      if (!isSafePublicUrl(candidate.url)) {
        continue;
      }
      const normalized = normalizeStreamSource(
        {
          url: candidate.url,
          referer: finalUrl,
          origin,
          label: candidate.label ?? null,
          quality: candidate.quality ?? null,
        },
        { providerName: NAME, language: 'sub', baseUrl: finalUrl },
      );
      if (normalized !== null) {
        if (!seenUrls.has(normalized.url)) {
          seenUrls.add(normalized.url);
          sources.push(normalized);
        }
        continue;
      }
      // Valid http(s) URL that is not direct media -> embed page to follow.
      embeds.push({ url: candidate.url, name: candidate.label ?? '' });
    }

    for (const embed of embeds) {
      let resolved;
      try {
        resolved = await resolveEmbed(embed.url, {
          timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
        });
      } catch (err) {
        console.warn(`[anime4up] embed ${embed.url} skipped: ${err?.message ?? err}`);
        continue;
      }
      for (const source of resolved) {
        if (seenUrls.has(source.url)) {
          continue;
        }
        seenUrls.add(source.url);
        sources.push({
          ...source,
          quality: source.quality !== 'auto'
            ? source.quality
            : (inferScraperQuality(embed.name) ?? 'auto'),
        });
      }
    }
    if (sources.length === 0 && candidates.length === 0 && scriptCandidates.length === 0) {
      throw new AnimeApiError(ERROR_CODES.STREAM_UNAVAILABLE, 'Anime4Up: no media entries found', {
        provider: NAME,
        failureCategory: 'SOURCE_NOT_FOUND',
      });
    }
    return sources;
  });
}

/** Default embed resolver (the extractor registry). */
async function registryResolveEmbed(embedUrl, options) {
  const { resolveEmbed } = await import('../../extractors/registry.js');
  return resolveEmbed(embedUrl, options);
}

/** Extracts server-row candidates (data-* attributes) from the page HTML. */
function extractServerRows(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    for (const attr of DATA_ATTRIBUTES) {
      const attrRe = new RegExp(`${attr}="([^"]*)"`, 'i');
      const attrMatch = attrRe.exec(raw);
      if (!attrMatch) {
        continue;
      }
      const url = normalizeUrl(decodeHtmlAttribute(attrMatch[1]), baseUrl);
      if (url !== null && !seen.has(url)) {
        seen.add(url);
        const name = serverNameFrom(raw);
        out.push({ url, label: name, quality: inferScraperQuality(name) });
      }
    }
  };

  // 1) Container-scoped scan: only server rows inside known containers.
  const containerTagRe = /<(div|ul|ol|section|table)\b[^>]*?(?:id|class)="([^"]*)"[^>]*>([\s\S]*?)(?:<\/\1>)/gi;
  let containerMatch;
  while ((containerMatch = containerTagRe.exec(html)) !== null) {
    const attrs = containerMatch[2];
    const selector = SERVER_CONTAINER_SELECTORS.find((candidate) =>
      attrs.split(/\s+/).some((token) => token === candidate.slice(1) || token === candidate)
    );
    if (!selector) {
      continue;
    }
    const body = containerMatch[3];
    const itemRe = new RegExp(`<${SERVER_ITEM_TAGS}[^>]*data-[^>]*>[\\s\\S]*?<\\/${SERVER_ITEM_TAGS}>`, 'gi');
    let itemMatch;
    while ((itemMatch = itemRe.exec(body)) !== null) {
      push(itemMatch[0]);
    }
  }

  // 2) Page-wide fallback: bare data-* rows outside styled containers.
  if (out.length === 0) {
    const bareRe = /<[a-z][^>]*?\b(data-(?:src|video|url|watch|embed|iframe))="([^"]*)"[^>]*>/gi;
    let bareMatch;
    while ((bareMatch = bareRe.exec(html)) !== null) {
      push(bareMatch[0]);
    }
  }
  return out;
}

/** Extracts jwplayer-style `file`/`label` entries from inline scripts. */
function extractPlayerFileEntries(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const push = (file, label) => {
    const url = normalizeUrl(decodeHtmlAttribute(file), baseUrl);
    if (url !== null && !seen.has(url)) {
      seen.add(url);
      out.push({ url, label: label ?? null, quality: inferScraperQuality(label) });
    }
  };

  let match;
  PLAYER_SOURCES_REGEX.lastIndex = 0;
  while ((match = PLAYER_SOURCES_REGEX.exec(html)) !== null) {
    const body = match[1];
    const fileMatch = /file\s*:\s*"([^"]+)"/i.exec(body);
    if (fileMatch) {
      const labelMatch = /label\s*:\s*"([^"]*)"/i.exec(body);
      push(fileMatch[1], labelMatch?.[1]);
    }
  }
  FILE_LABEL_REGEX.lastIndex = 0;
  while ((match = FILE_LABEL_REGEX.exec(html)) !== null) {
    push(match[1], match[2]);
  }
  LABEL_FILE_REGEX.lastIndex = 0;
  while ((match = LABEL_FILE_REGEX.exec(html)) !== null) {
    push(match[2], match[1]);
  }
  BARE_FILE_REGEX.lastIndex = 0;
  while ((match = BARE_FILE_REGEX.exec(html)) !== null) {
    push(match[1], null);
  }
  return out;
}

function serverNameFrom(raw) {
  const nameMatch = /data-name="([^"]*)"/i.exec(raw);
  if (nameMatch) {
    return nameMatch[1].trim();
  }
  const titleMatch = /title="([^"]*)"/i.exec(raw);
  if (titleMatch) {
    return titleMatch[1].trim();
  }
  const textMatch = />([^<>]+)</.exec(raw);
  return textMatch ? textMatch[1].replace(/\s+/g, ' ').trim() : '';
}

/** Parses every episode link with its number from the anime page HTML. */
function extractEpisodes(html, baseUrl) {
  const out = [];
  const seen = new Set();
  let match;
  EPISODE_LINK_PATTERN.lastIndex = 0;
  while ((match = EPISODE_LINK_PATTERN.exec(html)) !== null) {
    const rawHref = decodeHtmlAttribute(match[1]);
    const url = normalizeUrl(rawHref, baseUrl);
    if (url === null) {
      continue;
    }
    const label = stripTags(match[2]);
    const number = episodeNumberFrom(url, label);
    if (number === null || seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push({ number, url });
  }
  return out.sort((a, b) => a.number - b.number);
}

function episodeNumberFrom(url, label) {
  for (const pattern of EPISODE_LINK_PATTERNS) {
    const match = pattern.exec(url) ?? pattern.exec(label);
    if (match) {
      const number = Number(match[1]);
      if (Number.isInteger(number)) {
        return number;
      }
    }
  }
  const tail = GENERIC_TAIL_PATTERN.exec(url.split('?')[0]);
  if (tail) {
    const number = Number(tail[1]);
    if (Number.isInteger(number) && !(number >= 1900 && number <= 2099)) {
      return number;
    }
  }
  return null;
}

function pickBestResult(html, baseUrl, query) {
  const links = extractSearchLinks(html, baseUrl);
  if (links.length === 0) {
    return null;
  }
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) {
    return links[0].url;
  }
  let best = null;
  let bestScore = 0;
  for (const link of links) {
    const label = link.label.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (label.includes(token)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      best = link.url;
      bestScore = score;
    }
  }
  return best ?? links[0].url;
}

function extractSearchLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const pattern of SEARCH_LINK_PATTERNS) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = normalizeUrl(decodeHtmlAttribute(match[1]), baseUrl);
      if (url !== null && !seen.has(url)) {
        seen.add(url);
        out.push({ url, label: stripTags(match[2]) });
      }
    }
  }
  return out;
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}