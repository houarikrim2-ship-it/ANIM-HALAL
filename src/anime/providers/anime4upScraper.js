/**
 * Anime4Up scraper provider (anime4up.rest / w1.anime4up.rest mirrors).
 */
import { ANIME_ANIME4UP_BASE_URL, ANIME_SCRAPER_TIMEOUT_MS } from '../config.js';
import { AnimeApiError, ERROR_CODES } from '../errors.js';
import { normalizeStreamSource, normalizeUrl } from '../normalize.js';
import {
  canonicalEmbedProvider,
  decodeHtmlAttribute,
  embedFallbackSource,
  fetchHtml,
  inferScraperQuality,
  isNonPlayableEmbedUrl,
  isSafePublicUrl,
  isStaticAssetUrl,
  normalizeEmbedResult,
  normalizeTitle,
  opportunisticDirectProbe,
  calculateTitleScore,
  sanitizeScraperLabel,
  withScraperGuard,
} from './scraperSupport.js';
import { toDirectStreamUrl } from './witanimeScraper.js';

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
  /<(?:div|h[123]|a)[^>]*class="[^"]*anime-card-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  /<h[123][^>]*class="[^"]*(?:entry-title|post-title|anime-title)[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  /<a[^>]+class="[^"]*(?:anime-card-title|post-title|anime-item|search-item|post-card|anime-title)[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  /<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
];

const EPISODE_LINK_PATTERN = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

const PLAYER_SOURCES_REGEX = /sources\s*:\s*\[\s*\{([\s\S]*?)\}\s*\]/gi;
const FILE_LABEL_REGEX = /file\s*:\s*"([^"]+)"\s*,\s*label\s*:\s*"([^"]*)"/gi;
const LABEL_FILE_REGEX = /label\s*:\s*"([^"]*)"\s*,\s*file\s*:\s*"([^"]+)"/gi;
const BARE_FILE_REGEX = /file\s*:\s*"(https?:\/\/[^"]+\.(?:m3u8|mp4|webm|m4v)[^"]*)"\s*(?:,\s*(?:label|type)\s*:\s*"[^"]*")?/gi;

/** Searches the site and returns the most relevant anime page URL, or null. */
export async function searchAnimePage(title, options = {}) {
  return withScraperGuard(NAME, async () => {
    const query = String(title ?? '').trim();
    if (query === '') return null;
    const base = options.baseUrl ?? ANIME_ANIME4UP_BASE_URL;
    const searchUrl = `${base}/?search_param=animes&s=${encodeURIComponent(query)}`;

    console.log(`[anime4up] SEARCH_PAGE query="${query}" url="${searchUrl}"`);
    const { text, finalUrl } = await fetchHtml(searchUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const result = pickBestResult(text, finalUrl, query);
    console.log(`[anime4up] SEARCH_RESULT query="${query}" match="${result || 'NONE'}"`);
    return result;
  });
}

/** Full details for an anime from its Anime4Up page. */
export async function info(animeId, options = {}) {
    return withScraperGuard(NAME, async () => {
        const url = animeId.startsWith('http') ? animeId : `${ANIME_ANIME4UP_BASE_URL}/anime/${animeId}/`;
        const { text, finalUrl } = await fetchHtml(url, {
            provider: NAME,
            timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
        });

        const title = text.match(/<h1[^>]*class="[^"]*anime-details-title[^"]*"[^>]*>(.*?)<\/h1>/i)?.[1]?.trim();
        const story = text.match(/<p[^>]*class="[^"]*anime-story[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]?.trim();
        const cover = text.match(/<img[^>]*class="[^"]*thumbnail[^"]*"[^>]*src="([^"]+)"/i)?.[1];

        const genres = [];
        const genreRe = /<ul\s+class="[^"]*anime-genres[^"]*"[^>]*>([\s\S]*?)<\/ul>/i;
        const genreHtml = genreRe.exec(text)?.[1] || '';
        const itemRe = /<a[^>]*>(.*?)<\/a>/gi;
        let m;
        while ((m = itemRe.exec(genreHtml)) !== null) {
            genres.push(m[1].trim());
        }

        const statusMatch = text.match(/<div[^>]*class="[^"]*anime-info[^"]*"[^>]*>[\s\S]*?<span>حالة الأنمي :<\/span>[\s\S]*?<a[^>]*>(.*?)<\/a>/i);
        const status = statusMatch ? (statusMatch[1].includes('مستمر') ? 'Ongoing' : 'Completed') : 'Unknown';

        return {
            id: animeId,
            title: { romaji: title, english: title, native: title },
            coverImage: { large: cover, extraLarge: cover },
            description: story,
            genres,
            status,
            provider: NAME
        };
    });
}

/** Catalog rows (popular/trending) from Anime4Up. */
export async function catalog(kind, { page = 1 } = {}) {
    return withScraperGuard(NAME, async () => {
        let path;
        if (kind === 'popular') {
            // Attempt dynamic discovery of the anime list path
            const { text: homeText } = await fetchHtml(ANIME_ANIME4UP_BASE_URL, {
                provider: NAME,
                timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
            });

            // Look for "Anime List" or "قائمة الأنمي" link
            const listMatch = homeText.match(/href="([^"]*\/%d9%82%d8%a7%d8%a6%d9%85%d8%a9-%d8%a7%d9%84%d8%a7%d9%86%d9%85%d9%8a\/|[^"]*\/anime-list[^"]*\/)"/i);
            const listPath = listMatch ? listMatch[1] : '/%d9%82%d8%a7%d8%a6%d9%85%d8%a9-%d8%a7%d9%84%d8%a7%d9%86%d9%85%d9%8a/';

            // Ensure path is relative and clean
            const cleanPath = listPath.startsWith('http') ? new URL(listPath).pathname : listPath;
            path = `${cleanPath.replace(/\/$/, '')}/page/${page}/`;
        } else {
            path = `/?s=`;
        }

        const url = `${ANIME_ANIME4UP_BASE_URL}${path}`;
        const { text, finalUrl } = await fetchHtml(url, {
            provider: NAME,
            timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
        });

        const out = [];
        // Updated regex to capture Anime4Up's card structure more reliably
        const cardRe = /<div\s+class="[^"]*anime-card-poster[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]+alt="([^"]+)"[\s\S]*?<a\s+href="([^"]+)"/gi;
        let match;
        while ((match = cardRe.exec(text)) !== null) {
            const animeUrl = match[3];
            const animeId = animeUrl.split('/').filter(Boolean).pop();
            if (animeId) {
                out.push({
                    id: animeId,
                    title: { romaji: match[2], english: match[2], native: match[2] },
                    coverImage: { large: match[1], extraLarge: match[1] },
                    provider: NAME
                });
            }
        }
        return out;
    });
}

/**
 * Returns the episode page URL for [number] on the anime page, or null.
 * Exact match first, then the nearest lower-numbered episode.
 */
export async function episodePageUrl(animePageUrl, number, options = {}) {
  return withScraperGuard(NAME, async () => {
    console.log(`[anime4up] EPISODE_PAGE_URL_START animePage="${animePageUrl}" ep=${number}`);
    const { text, finalUrl } = await fetchHtml(animePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const episodes = extractEpisodes(text, finalUrl);
    console.log(`[anime4up] EPISODE_LIST count=${episodes.length} animePage="${animePageUrl}"`);

    if (episodes.length === 0) {
      console.warn(`[anime4up] EPISODE_LIST_EMPTY for ${animePageUrl}`);
      return null;
    }
    const target = Number(number);
    const exact = episodes.find((entry) => entry.number === target);
    const entry = exact ?? episodes
      .filter((candidate) => candidate.number <= target)
      .sort((a, b) => b.number - a.number)[0];

    const result = entry?.url ?? null;
    console.log(`[anime4up] EPISODE_PAGE_MATCH target=${target} found=${entry?.number || 'NONE'} url="${result || 'NONE'}"`);
    return result;
  });
}

/**
 * Resolves playable media sources from an Anime4Up episode page.
 */
export async function resolveEpisodeSources(episodePageUrl, options = {}) {
  return withScraperGuard(NAME, async () => {
    const resolveEmbed = options.resolveEmbed ?? registryResolveEmbed;
    const { text, finalUrl } = await fetchHtml(episodePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const origin = new URL(finalUrl).origin;

    const watchEmbeds = extractWatchServersEmbed(text, finalUrl);
    const watchCandidates = extractServerRows(text, finalUrl);
    const scriptCandidates = extractPlayerFileEntries(text, finalUrl);
    const downloadCandidates = extractDownloadLinks(text, finalUrl);

    console.log(`[anime4up] DISCOVERED_CANDIDATES watch_embed=${watchEmbeds.length} watch=${watchCandidates.length} script=${scriptCandidates.length} download=${downloadCandidates.length}`);

    const sources = [];
    const seenUrls = new Set();

    const processCandidate = async (candidate, kind) => {
      if (!isSafePublicUrl(candidate.url)) return;
      if (isStaticAssetUrl(candidate.url)) return;
      if (isNonPlayableEmbedUrl(candidate.url)) return;

      const directCandidate = toDirectStreamUrl(candidate.url);
      const probe = await opportunisticDirectProbe(directCandidate, { referer: finalUrl, provider: NAME });
      if (!probe?.safe) return;

      const safeLabel = sanitizeScraperLabel(candidate.label);
      const normalized = normalizeStreamSource(
        {
          url: probe.url,
          referer: finalUrl,
          origin,
          label: safeLabel,
          quality: candidate.quality ?? null,
          type: probe.type,
        },
        { providerName: NAME, language: 'sub', baseUrl: finalUrl, sourceKind: kind },
      );

      if (normalized !== null && normalized.extractionStatus === 'DIRECT') {
        if (!seenUrls.has(normalized.url)) {
          seenUrls.add(normalized.url);
          sources.push(normalized);
          console.log(`[anime4up] PROVIDER_ADDED name=${kind} url=${normalized.url.substring(0, 100)} type=DIRECT`);
        }
        return;
      }

      // If not direct media, attempt embed resolution if it's a WATCH source or a known player host
      const isWatch = kind === 'WATCH';
      const canonicalProvider = canonicalEmbedProvider(directCandidate);
      const isKnownPlayer = canonicalProvider !== null && canonicalProvider !== 'download';

      if (isWatch || isKnownPlayer) {
          console.log(`[anime4up] PROVIDER_ATTEMPT_EMBED name=${safeLabel} url=${directCandidate}`);
          let result;
          try {
            result = await resolveEmbed(directCandidate, {
              timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
              sourceKind: kind
            });
          } catch (err) {
            result = { sources: [], error: err.message, extractionStatus: 'FAILED' };
          }

          const resolved = normalizeEmbedResult(result);
          if (resolved.extractionStatus === 'DIRECT') {
            for (const source of resolved.sources) {
              if (seenUrls.has(source.url)) continue;
              seenUrls.add(source.url);
              sources.push({
                ...source,
                sourceKind: kind,
                quality: source.quality !== 'auto' ? source.quality : (inferScraperQuality(candidate.label) ?? 'auto'),
              });
            }
          } else if (resolved.extractionStatus === 'EMBED' || (resolved.extractionStatus === 'FAILED' && resolved.status !== 404)) {
            const finalProvider = canonicalProvider ?? NAME;
            const fallback = normalizeStreamSource(
              { ...candidate, url: directCandidate, name: safeLabel ?? finalProvider, type: kind === 'DOWNLOAD' ? 'download' : 'embed' },
              { providerName: finalProvider, allowEmbeds: true, baseUrl: finalUrl, sourceKind: kind }
            );
            if (fallback && fallback.extractionStatus === 'EMBED' && !seenUrls.has(fallback.url)) {
              seenUrls.add(fallback.url);
              sources.push(fallback);
            }
          }
      }
    };

    // Parallelize mirror processing to avoid sequential timeouts
    const allCandidates = [
        ...watchEmbeds.map(c => ({ c, kind: 'WATCH' })),
        ...watchCandidates.map(c => ({ c, kind: 'WATCH' })),
        ...scriptCandidates.map(c => ({ c, kind: 'WATCH' })),
        ...downloadCandidates.map(c => ({ c, kind: 'DOWNLOAD' }))
    ];

    await Promise.allSettled(allCandidates.map(item => processCandidate(item.c, item.kind)));

    if (sources.length === 0) {
      throw new AnimeApiError(ERROR_CODES.STREAM_UNAVAILABLE, 'Anime4Up: no playable sources found', {
        provider: NAME,
        failureCategory: 'SOURCE_NOT_FOUND',
      });
    }

    return sources.sort((a, b) => {
        if (a.extractionStatus === 'DIRECT' && b.extractionStatus !== 'DIRECT') return -1;
        if (a.extractionStatus !== 'DIRECT' && b.extractionStatus === 'DIRECT') return 1;
        return 0;
    });
  });
}

/** Default embed resolver (the extractor registry). */
async function registryResolveEmbed(embedUrl, options) {
  const { resolveEmbed } = await import('../../extractors/registry.js');
  return resolveEmbed(embedUrl, options);
}

function extractWatchServersEmbed(html, baseUrl) {
    const out = [];
    const seen = new Set();

    const patterns = [
        { name: 'watch_fhd', quality: '1080p' },
        { name: 'watch_hd', quality: '720p' },
        { name: 'watch_SD', quality: '480p' }
    ];

    patterns.forEach(p => {
        const re = new RegExp(`name=['"]${p.name}['"]\\s+value=['"]([^'"]+)['"]`, 'i');
        const match = re.exec(html);
        if (match) {
            try {
                const decoded = Buffer.from(match[1], 'base64').toString('utf8');
                const json = JSON.parse(decoded);
                if (Array.isArray(json)) {
                    json.forEach(s => {
                        if (s.link) {
                            const url = normalizeUrl(s.link, baseUrl);
                            if (url && !seen.has(url)) {
                                seen.add(url);
                                out.push({ url, label: s.name || p.name, quality: p.quality });
                            }
                        }
                    });
                }
            } catch (e) {
                console.warn(`[anime4up] failed to decode ${p.name}`);
            }
        }
    });
    return out;
}

function extractDownloadLinks(html, baseUrl) {
    const out = [];
    const seen = new Set();
    // Matches common download link patterns in Arabic WordPress themes
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)(?:FHD|HD|SD|خارقة|عالية|متوسطة)[\s\S]*?<\/a>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
        const url = normalizeUrl(decodeHtmlAttribute(match[1]), baseUrl);
        if (url && !seen.has(url)) {
            seen.add(url);
            const label = stripTags(match[2]);
            out.push({ url, label, quality: inferScraperQuality(label) || inferScraperQuality(url) });
        }
    }

    // Fallback: look for <td> cells containing links near quality labels
    const tdRe = /<td[^>]*>(.*?)<\/td>/gi;
    while ((match = tdRe.exec(html)) !== null) {
        const body = match[1];
        const linkMatch = /<a[^>]+href="([^"]+)"/i.exec(body);
        if (linkMatch) {
            const url = normalizeUrl(decodeHtmlAttribute(linkMatch[1]), baseUrl);
            if (url && !seen.has(url)) {
                const quality = inferScraperQuality(body);
                if (quality) {
                    seen.add(url);
                    out.push({ url, label: 'download', quality });
                }
            }
        }
    }

    return out;
}

/** Extracts server-row candidates (data-* attributes) from the page HTML. */
function extractServerRows(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    for (const attr of DATA_ATTRIBUTES) {
      const attrRe = new RegExp(`${attr}="([^"]*)"`, 'i');
      const attrMatch = attrRe.exec(raw);
      if (!attrMatch) continue;
      const url = normalizeUrl(decodeHtmlAttribute(attrMatch[1]), baseUrl);
      if (url !== null && !seen.has(url)) {
        seen.add(url);
        const name = serverNameFrom(raw);
        out.push({ url, label: name, quality: inferScraperQuality(name) });
      }
    }
  };

  const containerTagRe = /<(div|ul|ol|section|table)\b[^>]*?(?:id|class)="([^"]*)"[^>]*>([\s\S]*?)(?:<\/\1>)/gi;
  let containerMatch;
  while ((containerMatch = containerTagRe.exec(html)) !== null) {
    const attrs = containerMatch[2];
    const selector = SERVER_CONTAINER_SELECTORS.find((candidate) =>
      attrs.split(/\s+/).some((token) => token === candidate.slice(1) || token === candidate)
    );
    if (!selector) continue;
    const body = containerMatch[3];
    const itemRe = new RegExp(`<${SERVER_ITEM_TAGS}[^>]*data-[^>]*>[\\s\\S]*?<\\/${SERVER_ITEM_TAGS}>`, 'gi');
    let itemMatch;
    while ((itemMatch = itemRe.exec(body)) !== null) push(itemMatch[0]);
  }

  if (out.length === 0) {
    const bareRe = /<[a-z][^>]*?\b(data-(?:src|video|url|watch|embed|iframe))="([^"]*)"[^>]*>/gi;
    let bareMatch;
    while ((bareMatch = bareRe.exec(html)) !== null) push(bareMatch[0]);

    // Also look for raw iframes that look like watch servers
    const iframeRe = /<iframe[^>]+src="([^"]+)"[^>]*>/gi;
    while ((bareMatch = iframeRe.exec(html)) !== null) {
        const url = normalizeUrl(decodeHtmlAttribute(bareMatch[1]), baseUrl);
        if (url && !seen.has(url)) {
            const cp = canonicalEmbedProvider(url);
            if (cp && cp !== 'download') {
                seen.add(url);
                out.push({ url, label: cp, quality: 'auto' });
            }
        }
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
  while ((match = FILE_LABEL_REGEX.exec(html)) !== null) push(match[1], match[2]);
  LABEL_FILE_REGEX.lastIndex = 0;
  while ((match = LABEL_FILE_REGEX.exec(html)) !== null) push(match[2], match[1]);
  BARE_FILE_REGEX.lastIndex = 0;
  while ((match = BARE_FILE_REGEX.exec(html)) !== null) push(match[1], null);
  return out;
}

function serverNameFrom(raw) {
  const nameMatch = /data-name="([^"]*)"/i.exec(raw);
  if (nameMatch) return nameMatch[1].trim();
  const titleMatch = /title="([^"]*)"/i.exec(raw);
  if (titleMatch) return titleMatch[1].trim();
  const textMatch = />([^<>]+)</.exec(raw);
  return textMatch ? textMatch[1].replace(/\s+/g, ' ').trim() : '';
}

function extractEpisodes(html, baseUrl) {
  const out = [];
  const seen = new Set();
  let match;
  EPISODE_LINK_PATTERN.lastIndex = 0;
  while ((match = EPISODE_LINK_PATTERN.exec(html)) !== null) {
    const rawHref = decodeHtmlAttribute(match[1]);
    const url = normalizeUrl(rawHref, baseUrl);
    if (url === null) continue;
    const label = stripTags(match[2]);
    const number = episodeNumberFrom(url, label);
    if (number === null || seen.has(url)) continue;
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
      if (Number.isInteger(number)) return number;
    }
  }
  const tail = GENERIC_TAIL_PATTERN.exec(url.split('?')[0]);
  if (tail) {
    const number = Number(tail[1]);
    if (Number.isInteger(number) && !(number >= 1900 && number <= 2099)) return number;
  }
  return null;
}

function pickBestResult(html, baseUrl, query) {
  const links = extractSearchLinks(html, baseUrl);
  console.log(`[anime4up] EXTRACT_SEARCH_LINKS count=${links.length} query="${query}"`);
  if (links.length === 0) return null;
  let best = null, bestScore = -1000;
  for (const link of links) {
    let score = calculateTitleScore(query, link.label);
    console.log(`[anime4up] SCORE_CANDIDATE query="${query}" candidate="${link.label}" score=${score} url="${link.url}"`);
    if (link.url.includes('/anime/')) score += 20;
    if (!query.toLowerCase().includes('recap') && (link.label.toLowerCase().includes('recap') || link.label.includes('ملخص'))) score -= 30;
    if (score > bestScore) {
      best = link.url;
      bestScore = score;
    }
  }
  const winner = (best === null || bestScore <= 0) ? null : best;
  console.log(`[anime4up] PICK_BEST winner=${winner || 'NONE'} score=${bestScore}`);
  return winner;
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
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
