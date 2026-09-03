/**
 * WitAnime scraper provider (witanime.com / active mirrors).
 */
import { ANIME_SCRAPER_TIMEOUT_MS, ANIME_WITANIME_BASE_URL } from '../config.js';
import { AnimeApiError, ERROR_CODES } from '../errors.js';
import { normalizeStreamSource, normalizeUrl } from '../normalize.js';
import {
  base64Decode,
  calculateTitleScore,
  canonicalEmbedProvider,
  decodeHtmlAttribute,
  embedFallbackSource,
  fetchHtml,
  hexToBytes,
  inferScraperQuality,
  isNonPlayableEmbedUrl,
  isSafePublicUrl,
  isStaticAssetUrl,
  normalizeEmbedResult,
  normalizeTitle,
  opportunisticDirectProbe,
  parseIntArray,
  parseStringArray,
  sanitizeScraperLabel,
  withScraperGuard,
  xorDecode,
} from './scraperSupport.js';

export const NAME = 'witanime';
export const PROVIDER_ID = 'witanime';

const MAX_DOWNLOAD_GROUPS = 100;

const SECRET_KEY_REGEX = /var _m\s*=\s*\{[^}]*"r"\s*:\s*"([^"]+)"\s*\}/;
const GROUP_COUNT_REGEX = /var _b\s*=\s*\{[^}]*"l"\s*:\s*"(\d+)"\s*\}/;
const X_SEQUENCES_REGEX = /var _x\s*=\s*\[([^\]]+)\]/;
const ZT_RESOURCES_REGEX = /var _zT\s*=\s*"([^"]+)"/;
const ZV_CONFIGS_REGEX = /var _zV\s*=\s*"([^"]+)"/;
const CONFIG_OBJECT_REGEX = /\{[^{}]*\}/g;
const CONFIG_D_REGEX = /"d"\s*:\s*\[([^\]]*)\]/;
const CONFIG_K_REGEX = /"k"\s*:\s*"([^"]+)"/;
const YONAPLAY_REGEX = /^https:\/\/yonaplay\.net\/embed\.php\?id=\d+$/;

const EPISODE_ENTRY_REGEX = /\{\s*"number"\s*:\s*"(\d+)"\s*,\s*"url"\s*:\s*"([^"]+)"\s*,/g;

const PROCESSED_EPISODE_REGEX = /var\s+processedEpisodeData\s*=\s*'([^']+)'/;

export function decodeEpisodeGrid(script) {
  const payloadMatch = PROCESSED_EPISODE_REGEX.exec(script ?? '');
  if (!payloadMatch) return [];
  const parts = payloadMatch[1].split('.');
  if (parts.length !== 2) return [];
  const data = base64Decode(parts[0]);
  const key = base64Decode(parts[1]);
  if (data === null || key === null) return [];
  const json = xorDecode(data, key).replace(/\\"/g, '"');
  const out = [];
  let match;
  EPISODE_ENTRY_REGEX.lastIndex = 0;
  while ((match = EPISODE_ENTRY_REGEX.exec(json)) !== null) {
    const number = Number(match[1]);
    const url = match[2].replace(/\\\//g, '/');
    if (Number.isInteger(number) && url !== '') {
      out.push({ number, url });
    }
  }
  return out;
}

export function decodeDownloadUrls(script) {
  const keyMatch = SECRET_KEY_REGEX.exec(script ?? '');
  const countMatch = GROUP_COUNT_REGEX.exec(script ?? '');
  const xMatch = X_SEQUENCES_REGEX.exec(script ?? '');
  if (!keyMatch || !countMatch || !xMatch) return [];
  const secret = base64Decode(keyMatch[1]);
  const count = Number(countMatch[1]);
  if (secret === null || !Number.isInteger(count) || count <= 0 || count > MAX_DOWNLOAD_GROUPS) return [];
  const xChunks = parseStringArray(xMatch[1]);
  if (xChunks.length < count) return [];

  const urls = [];
  for (let i = 0; i < count; i += 1) {
    const pRe = new RegExp(`var _p${i}\\s*=\\s*\\[([^\\]]+)\\]`);
    const pMatch = pRe.exec(script);
    if (!pMatch) continue;
    const seqBytes = hexToBytes(xChunks[i]);
    if (seqBytes === null) continue;
    const seq = parseIntArray(xorDecode(seqBytes, secret));
    if (seq === null || seq.length === 0) continue;
    const chunks = parseStringArray(pMatch[1]);
    if (chunks.length !== seq.length) continue;
    const arranged = new Array(seq.length).fill('');
    let valid = true;
    for (let j = 0; j < chunks.length; j += 1) {
      if (!Number.isInteger(seq[j]) || seq[j] < 0 || seq[j] >= seq.length) {
        valid = false;
        break;
      }
      const bytes = hexToBytes(chunks[j]);
      if (bytes === null) {
        valid = false;
        break;
      }
      arranged[seq[j]] = xorDecode(bytes, secret);
    }
    if (!valid) continue;
    urls.push(arranged.join(''));
  }
  return urls;
}

export function decodeIframeResources(script) {
  const ztMatch = ZT_RESOURCES_REGEX.exec(script ?? '');
  const zvMatch = ZV_CONFIGS_REGEX.exec(script ?? '');
  if (!ztMatch || !zvMatch) return [];
  const resourcesBlob = base64Decode(ztMatch[1]);
  const configBlob = base64Decode(zvMatch[1]);
  if (resourcesBlob === null || configBlob === null) return [];
  const resources = parseStringArray(resourcesBlob.toString('latin1'));
  const offsets = parseConfigOffsets(configBlob.toString('latin1'));
  if (offsets.length < resources.length) return [];

  const out = [];
  for (let i = 0; i < resources.length; i += 1) {
    const reversed = resources[i]
      .split('')
      .reverse()
      .filter((ch) => /[A-Za-z0-9+/=]/.test(ch))
      .join('');
    const raw = base64Decode(reversed);
    if (raw === null) continue;
    const decoded = raw.toString('latin1');
    const offset = offsets[i];
    const url = offset > 0 && offset < decoded.length ? decoded.slice(0, -offset) : decoded;
    out.push(YONAPLAY_REGEX.test(url) ? `${url}&apiKey=9933bd27-92ea-4ee9-807d-e612029d6318` : url);
  }
  return out;
}

function parseConfigOffsets(content) {
  const out = [];
  let match;
  CONFIG_OBJECT_REGEX.lastIndex = 0;
  while ((match = CONFIG_OBJECT_REGEX.exec(content)) !== null) {
    const body = match[0];
    const dMatch = CONFIG_D_REGEX.exec(body);
    const kMatch = CONFIG_K_REGEX.exec(body);
    if (!dMatch || !kMatch) continue;
    const indexBytes = base64Decode(kMatch[1]);
    if (indexBytes === null) continue;
    const index = Number(indexBytes.toString('latin1'));
    if (!Number.isInteger(index)) continue;
    const values = parseIntArray(dMatch[1]) ?? [];
    const offset = values[index];
    if (Number.isInteger(offset)) out.push(offset);
  }
  return out;
}

export function toDirectStreamUrl(url) {
  const pixeldrain = /^https:\/\/pixeldrain\.com\/l\/([A-Za-z0-9]+)\/?$/.exec(url);
  if (pixeldrain) {
    return `https://pixeldrain.com/api/file/${pixeldrain[1]}`;
  }
  const mp4upload = /^https:\/\/(?:www\.)?mp4upload\.com\/([A-Za-z0-9]+)\/?$/.exec(url);
  if (mp4upload) {
    return `https://www.mp4upload.com/embed-${mp4upload[1]}.html`;
  }
  const yourupload = /^https:\/\/(?:www\.)?yourupload\.com\/watch\/([A-Za-z0-9]+)\/?$/.exec(url);
  if (yourupload) {
    return `https://www.yourupload.com/embed/${yourupload[1]}`;
  }
  return url;
}

    console.log(`[witanime] SEARCH_PAGE query="${query}" url="${searchUrl}"`);
    const { text, finalUrl } = await fetchHtml(searchUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const result = pickBestResult(text, finalUrl, query);
    console.log(`[witanime] SEARCH_RESULT query="${query}" match="${result || 'NONE'}"`);
    return result;
  });
}

/** Full details for an anime from its WITAnime page. */
export async function info(animeId, options = {}) {
    return withScraperGuard(NAME, async () => {
        const url = animeId.startsWith('http') ? animeId : `${ANIME_WITANIME_BASE_URL}/anime/${animeId}/`;
        const { text, finalUrl } = await fetchHtml(url, {
            provider: NAME,
            timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
        });

        const title = text.match(/<h1[^>]*class="[^"]*anime-details-title[^"]*"[^>]*>(.*?)<\/h1>/i)?.[1]?.trim();
        const story = text.match(/<p[^>]*class="[^"]*anime-story[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]?.trim();
        // Fixed cover selector based on audit results
        const coverMatch = text.match(/<img[^>]+src="([^"]+uploads[^"]+)"/i) || text.match(/<img[^>]*class="[^"]*thumbnail[^"]*"[^>]*src="([^"]+)"/i);
        const cover = coverMatch?.[1];

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

/** Catalog rows (trending/latest) from WITAnime. */
export async function catalog(kind, { page = 1 } = {}) {
    return withScraperGuard(NAME, async () => {
        // Kind mapping: 'recent' -> /episode/page/X/ , 'popular' -> /قائمة-الانمي/page/X/
        const path = kind === 'recent' ? `/episode/page/${page}/` : `/قائمة-الانمي/page/${page}/`;
        const url = `${ANIME_WITANIME_BASE_URL}${path}`;
        const { text, finalUrl } = await fetchHtml(url, {
            provider: NAME,
            timeoutMs: ANIME_SCRAPER_TIMEOUT_MS,
        });

        const out = [];
        // Matches the anime cards in listing pages
        const re = /<div\s+class="[^"]*anime-card-poster[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]+alt="([^"]+)"[\s\S]*?<a\s+href="([^"]+)"/gi;
        let match;
        while ((match = re.exec(text)) !== null) {
            const animeUrl = match[3] ?? '';
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

export async function episodePageUrl(animePageUrl, number, options = {}) {
  return withScraperGuard(NAME, async () => {
    console.log(`[witanime] EPISODE_PAGE_URL_START animePage="${animePageUrl}" ep=${number}`);
    const { text, finalUrl } = await fetchHtml(animePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const episodes = decodeEpisodeGrid(text);
    console.log(`[witanime] EPISODE_GRID count=${episodes.length} animePage="${animePageUrl}"`);

    if (episodes.length === 0) {
      console.warn(`[witanime] EPISODE_GRID_EMPTY for ${animePageUrl}`);
      return null;
    }
    const target = Number(number);
    const exact = episodes.find((entry) => entry.number === target);
    const entry = exact ?? episodes
      .filter((candidate) => candidate.number <= target)
      .sort((a, b) => b.number - a.number)[0];

    const result = entry ? normalizeUrl(entry.url, finalUrl) : null;
    console.log(`[witanime] EPISODE_PAGE_MATCH target=${target} found=${entry?.number || 'NONE'} url="${result || 'NONE'}"`);
    return result;
  });
}

export async function resolveEpisodeSources(episodePageUrl, options = {}) {
  return withScraperGuard(NAME, async () => {
    const resolveEmbed = options.resolveEmbed ?? registryResolveEmbed;
    const { text, finalUrl } = await fetchHtml(episodePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });

    const sources = [];
    const seenUrls = new Set();

    // 1. Download URLs (priority for direct media discovery)
    const downloadUrls = decodeDownloadUrls(text);
    console.log(`[witanime] DISCOVERED_DOWNLOAD_GROUPS count=${downloadUrls.length}`);
    for (const raw of downloadUrls) {
      if (isStaticAssetUrl(raw)) {
        console.warn(`[witanime] PROVIDER_FILTERED name=download url=${raw.substring(0, 100)} reason=STATIC_ASSET`);
        continue;
      }
      const direct = toDirectStreamUrl(raw);
      if (!isSafePublicUrl(direct)) continue;

      // Preserve query by using opportunisticDirectProbe which keeps the final URL.
      const probe = await opportunisticDirectProbe(direct, { referer: finalUrl, provider: NAME });
      if (!probe.safe) {
        console.warn(`[witanime] PROVIDER_FILTERED name=download url=${direct.substring(0, 100)} reason=UNSAFE`);
        continue;
      }

      // Try direct normalization first
      const normalized = normalizeStreamSource(
        { url: probe.url, referer: finalUrl, origin: new URL(finalUrl).origin, label: null, quality: null, type: probe.type },
        { providerName: NAME, language: 'sub', baseUrl: finalUrl, sourceKind: 'DOWNLOAD' },
      );

      if (normalized !== null && !normalized.isEmbed && normalized.extractionStatus === 'DIRECT') {
        seenUrls.add(normalized.url);
        sources.push(normalized);
        console.log(`[witanime] SOURCE_CLASSIFIED provider=download finalType=DIRECT_MEDIA playable=true reason=DIRECT_CANDIDATE`);
        continue;
      }

      // Try resolving as embed if not already direct media
      let result;
      try {
        result = await resolveEmbed(direct, {
          timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
        });
      } catch (err) {
        result = { sources: [], error: err?.message ?? 'unknown', extractionStatus: 'FAILED' };
      }

      const resolved = normalizeEmbedResult(result);
      if (resolved.extractionStatus === 'DIRECT') {
        for (const source of resolved.sources) {
          if (seenUrls.has(source.url)) continue;
          seenUrls.add(source.url);
          sources.push({ ...source, sourceKind: 'DOWNLOAD' });
          console.log(`[witanime] SOURCE_CLASSIFIED provider=download_resolved finalType=DIRECT_MEDIA playable=true reason=EXTRACTOR_SUCCESS`);
        }
      } else if (resolved.extractionStatus === 'FAILED' && resolved.status !== 404) {
        // Stop forcing non-playable download links into the EMBED category
        const canonicalProvider = canonicalEmbedProvider(direct) ?? 'download';
        const fallback = normalizeStreamSource(
          { url: direct, name: 'download', type: 'download' },
          { providerName: canonicalProvider, allowEmbeds: true, baseUrl: finalUrl, sourceKind: 'DOWNLOAD' },
        );
        if (fallback && !seenUrls.has(fallback.url)) {
           // Only add to sources if it's actually playable/embed
           if (fallback.extractionStatus === 'EMBED') {
              seenUrls.add(fallback.url);
              sources.push(fallback);
              console.log(`[witanime] SOURCE_CLASSIFIED provider=${canonicalProvider} finalType=EMBEDDED_WEB playable=true reason=KNOWN_PLAYER_HOST`);
           } else {
              console.log(`[witanime] SOURCE_CLASSIFIED provider=${canonicalProvider} finalType=DOWNLOAD playable=false reason=NO_EXTRACTOR`);
           }
        }
      }
    }

    // 2. Watch-server embeds
    const watchServers = collectWatchServers(text, finalUrl);
    console.log(`[witanime] DISCOVERED_WATCH_SERVERS count=${watchServers.length}`);
    for (const embed of watchServers) {
      if (isStaticAssetUrl(embed.url)) {
        console.warn(`[witanime] PROVIDER_FILTERED name=${embed.name} url=${embed.url} reason=STATIC_ASSET`);
        continue;
      }
      if (isNonPlayableEmbedUrl(embed.url)) {
        console.warn(`[witanime] PROVIDER_FILTERED name=${embed.name} url=${embed.url} reason=NAV_PAGE`);
        continue;
      }
      console.log(`[witanime] PROVIDER_ATTEMPT name=${embed.name} url=${embed.url}`);
      let result;
      try {
        result = await resolveEmbed(embed.url, {
          timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
        });
      } catch (err) {
        console.warn(`[witanime] EXTRACTOR_FAILED name=${embed.name} error=${err?.message ?? err}`);
        result = { sources: [], error: err.message, extractionStatus: 'FAILED' };
      }

      const resolved = normalizeEmbedResult(result);

      if (resolved.extractionStatus === 'DIRECT') {
        console.log(`[witanime] SOURCE_CLASSIFIED provider=${embed.name} finalType=DIRECT_MEDIA playable=true reason=EXTRACTOR_SUCCESS count=${resolved.sources.length}`);
        for (const source of resolved.sources) {
          if (seenUrls.has(source.url)) continue;
          seenUrls.add(source.url);
          sources.push({
            ...source,
            extractionStatus: 'DIRECT',
            sourceKind: 'WATCH',
            quality: source.quality !== 'auto'
              ? source.quality
              : (inferScraperQuality(embed.name) ?? 'auto'),
          });
        }
      } else if (resolved.extractionStatus === 'EMBED' || (resolved.extractionStatus === 'FAILED' && resolved.status !== 404)) {
        const canonicalProvider = canonicalEmbedProvider(embed.url) ?? NAME;
        const normalized = normalizeStreamSource(
          embedFallbackSource({ ...embed, name: sanitizeScraperLabel(embed.name) ?? canonicalProvider }, canonicalProvider),
          { providerName: canonicalProvider, allowEmbeds: true, baseUrl: finalUrl, sourceKind: 'WATCH' }
        );
        if (normalized && !seenUrls.has(normalized.url)) {
          seenUrls.add(normalized.url);
          sources.push(normalized);
          console.log(`[witanime] SOURCE_CLASSIFIED provider=${canonicalProvider} finalType=EMBEDDED_WEB playable=true reason=WATCH_FALLBACK`);
        }
      }
    }

    return sources.sort((a, b) => {
        if (a.extractionStatus === 'DIRECT' && b.extractionStatus !== 'DIRECT') return -1;
        if (a.extractionStatus !== 'DIRECT' && b.extractionStatus === 'DIRECT') return 1;
        return 0;
    });
  });
}

async function registryResolveEmbed(embedUrl, options) {
  const { resolveEmbed } = await import('../../extractors/registry.js');
  return resolveEmbed(embedUrl, options);
}

export function collectWatchServers(html, pageUrl) {
  const resources = decodeIframeResources(html);
  if (resources.length === 0) return [];
  const names = new Map();
  const tabRe = /<a[^>]+data-server-id="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = tabRe.exec(html)) !== null) {
    const id = Number(match[1]);
    const serRe = /<span[^>]*class="[^"]*ser[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(match[2]);
    const name = serRe?.[1] ? stripTags(serRe[1]) : stripTags(match[2]);
    if (Number.isInteger(id) && name !== '') names.set(id, name);
  }
  const out = [];
  for (let i = 0; i < resources.length; i += 1) {
    const url = normalizeUrl(resources[i], pageUrl);
    if (url === null) continue;
    out.push({ url, name: names.get(i) ?? `الخادم ${i + 1}` });
  }
  return out;
}

function pickBestResult(html, baseUrl, query) {
  const links = extractResultLinks(html, baseUrl);
  console.log(`[witanime] EXTRACT_RESULT_LINKS count=${links.length} query="${query}"`);
  if (links.length === 0) return null;
  let best = null, bestScore = -Infinity;
  for (const link of links) {
    const normTitle = normalizeTitle(link.label);
    if (normTitle === '') continue;
    let score = calculateTitleScore(query, link.label);
    console.log(`[witanime] SCORE_CANDIDATE query="${query}" candidate="${link.label}" score=${score} url="${link.url}"`);
    if (score > 0 && link.url.includes('/anime/')) score += 20;
    if (!query.toLowerCase().includes('recap') && (link.label.toLowerCase().includes('recap') || link.label.includes('ملخص'))) score -= 30;
    if (score > bestScore) {
      best = link.url;
      bestScore = score;
    }
  }
  const winner = (best === null || bestScore <= 0) ? null : best;
  console.log(`[witanime] PICK_BEST winner=${winner || 'NONE'} score=${bestScore}`);
  return winner;
}

function extractResultLinks(html, baseUrl) {
  const out = [];
  const seen = new Map();
  const methodRank = { NONE: 0, URL_SLUG: 1, IMG_TITLE: 2, IMG_ALT: 3, TEXT: 4, ANCHOR_TITLE: 5 };
  const anchorRe = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const attrs = match[1];
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const rawHref = (hrefMatch[1] ?? hrefMatch[2] ?? '').replace(/&amp;/g, '&');
    if (!/\/anime\/|\/episode\//.test(rawHref)) continue;
    const url = normalizeUrl(rawHref, baseUrl);
    if (url === null) continue;
    if (url.includes('/anime-type/') || url.includes('/anime-genre/') || url.includes('/anime-season/')) continue;
    const { title, method } = extractResultTitle(attrs, match[2], url);
    if (seen.has(url)) {
      const idx = seen.get(url);
      if (methodRank[method] > methodRank[out[idx].extractionMethod]) {
        out[idx] = { url, label: title, extractionMethod: method };
      }
      continue;
    }
    seen.set(url, out.length);
    out.push({ url, label: title, extractionMethod: method });
  }
  return out;
}

function extractResultTitle(attrs, innerHtml, url) {
  const attr = (name) => {
    const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(attrs);
    return decodeHtmlAttribute(m ? (m[1] ?? m[2] ?? '') : '').trim();
  };
  const anchorTitle = attr('title');
  if (anchorTitle) return { title: anchorTitle, method: 'ANCHOR_TITLE' };
  const innerText = stripTags(innerHtml);
  if (innerText) return { title: innerText, method: 'TEXT' };
  const imgAttrs = /<img\s+([^>]*)>/i.exec(innerHtml);
  if (imgAttrs) {
    const imgAttr = (name) => {
      const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
      const m = re.exec(imgAttrs[1]);
      return decodeHtmlAttribute(m ? (m[1] ?? m[2] ?? '') : '').trim();
    };
    const imgAlt = imgAttr('alt');
    if (imgAlt) return { title: imgAlt, method: 'IMG_ALT' };
    const imgTitle = imgAttr('title');
    if (imgTitle) return { title: imgTitle, method: 'IMG_TITLE' };
  }
  const slug = extractSlugTitle(url);
  return slug ? { title: slug, method: 'URL_SLUG' } : { title: '', method: 'NONE' };
}

function extractSlugTitle(url) {
  try {
    const match = /\/anime\/([^/]+)/.exec(new URL(url).pathname);
    return match ? match[1].replace(/[-_]+/g, ' ').trim() : '';
  } catch { return ''; }
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
