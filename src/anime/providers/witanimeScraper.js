/**
 * WitAnime scraper provider (witanime.com / active mirrors).
 *
 * The site is a WordPress "Anime-Online-Theme" deployment that hides its
 * media URLs behind theme obfuscation. Three payloads matter:
 *
 * 1. Anime-page episode grid — `var processedEpisodeData = 'DATA.KEY'`
 *    (rnd.js): base64-decode both halves and XOR them; the result is a JSON
 *    array of `{ "number": "...", "url": "...", ... }` episode entries.
 * 2. Episode-page download groups — the `lkgx-js-extra` script block
 *    (`var _m`/`var _b`/`var _p*`/`var _x`, cx2.js): hex-XOR'd URL chunks
 *    arranged by a permutation. These decode to direct media / file-host
 *    URLs.
 * 3. Episode-page watch servers — `_zT`/`_zV` (yh00.js): reversed+base64
 *    iframe URLs. These are embed *pages*, never directly playable, so they
 *    are decoded for diagnostics but never returned as sources (the backend
 *    does not bypass embed players or anti-bot protection).
 *
 * Only http(s) URLs survive normalization; the relay re-validates the host
 * at playback time against its allowlist.
 */
import { ANIME_SCRAPER_TIMEOUT_MS, ANIME_WITANIME_BASE_URL } from '../config.js';
import { AnimeApiError, ERROR_CODES } from '../errors.js';
import { normalizeStreamSource, normalizeUrl } from '../normalize.js';
import {
  base64Decode,
  fetchHtml,
  hexToBytes,
  isSafePublicUrl,
  parseIntArray,
  parseStringArray,
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
const LKGX_SCRIPT_REGEX = /var _m[\s\S]*?var _x[\s\S]*?var _b/;

/** rnd.js: decodes the episode-grid payload into { number -> page URL }. */
export function decodeEpisodeGrid(script) {
  const payloadMatch = PROCESSED_EPISODE_REGEX.exec(script ?? '');
  if (!payloadMatch) {
    return [];
  }
  const parts = payloadMatch[1].split('.');
  if (parts.length !== 2) {
    return [];
  }
  const data = base64Decode(parts[0]);
  const key = base64Decode(parts[1]);
  if (data === null || key === null) {
    return [];
  }
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

/** cx2.js: decodes every `_p*`/`_x` URL group in order of `data-index`. */
export function decodeDownloadUrls(script) {
  const keyMatch = SECRET_KEY_REGEX.exec(script ?? '');
  const countMatch = GROUP_COUNT_REGEX.exec(script ?? '');
  const xMatch = X_SEQUENCES_REGEX.exec(script ?? '');
  if (!keyMatch || !countMatch || !xMatch) {
    return [];
  }
  const secret = base64Decode(keyMatch[1]);
  const count = Number(countMatch[1]);
  if (secret === null || !Number.isInteger(count) || count <= 0 || count > MAX_DOWNLOAD_GROUPS) {
    return [];
  }
  const xChunks = parseStringArray(xMatch[1]);
  if (xChunks.length < count) {
    return [];
  }

  const urls = [];
  for (let i = 0; i < count; i += 1) {
    const pRe = new RegExp(`var _p${i}\\s*=\\s*\\[([^\\]]+)\\]`);
    const pMatch = pRe.exec(script);
    if (!pMatch) {
      continue;
    }
    const seqBytes = hexToBytes(xChunks[i]);
    if (seqBytes === null) {
      continue;
    }
    const seq = parseIntArray(xorDecode(seqBytes, secret));
    if (seq === null || seq.length === 0) {
      continue;
    }
    const chunks = parseStringArray(pMatch[1]);
    if (chunks.length !== seq.length) {
      continue;
    }
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
    if (!valid) {
      continue;
    }
    urls.push(arranged.join(''));
  }
  return urls;
}

/** yh00.js: decodes the `_zT` resource array into iframe URLs (diagnostic only). */
export function decodeIframeResources(script) {
  const ztMatch = ZT_RESOURCES_REGEX.exec(script ?? '');
  const zvMatch = ZV_CONFIGS_REGEX.exec(script ?? '');
  if (!ztMatch || !zvMatch) {
    return [];
  }
  const resourcesBlob = base64Decode(ztMatch[1]);
  const configBlob = base64Decode(zvMatch[1]);
  if (resourcesBlob === null || configBlob === null) {
    return [];
  }
  const resources = parseStringArray(resourcesBlob.toString('latin1'));
  const offsets = parseConfigOffsets(configBlob.toString('latin1'));
  if (offsets.length < resources.length) {
    return [];
  }

  const out = [];
  for (let i = 0; i < resources.length; i += 1) {
    const reversed = resources[i]
      .split('')
      .reverse()
      .filter((ch) => /[A-Za-z0-9+/=]/.test(ch))
      .join('');
    const raw = base64Decode(reversed);
    if (raw === null) {
      continue;
    }
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
    if (!dMatch || !kMatch) {
      continue;
    }
    const indexBytes = base64Decode(kMatch[1]);
    if (indexBytes === null) {
      continue;
    }
    const index = Number(indexBytes.toString('latin1'));
    if (!Number.isInteger(index)) {
      continue;
    }
    const values = parseIntArray(dMatch[1]) ?? [];
    const offset = values[index];
    if (Number.isInteger(offset)) {
      out.push(offset);
    }
  }
  return out;
}

/** Rewrites a file-host view page to its direct streaming URL when known. */
export function toDirectStreamUrl(url) {
  const pixeldrain = /^https:\/\/pixeldrain\.com\/l\/([A-Za-z0-9]+)\/?$/.exec(url);
  if (pixeldrain) {
    return `https://pixeldrain.com/api/file/${pixeldrain[1]}`;
  }
  return url;
}

/** Searches the site and returns the most relevant anime page URL, or null. */
export async function searchAnimePage(title, options = {}) {
  return withScraperGuard(NAME, async () => {
    const query = String(title ?? '').trim();
    if (query === '') {
      return null;
    }
    const base = options.baseUrl ?? ANIME_WITANIME_BASE_URL;
    const searchUrl = `${base}/?s=${encodeURIComponent(query)}`;
    const { text, finalUrl } = await fetchHtml(searchUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const pageUrl = pickBestResult(text, finalUrl, query);
    return pageUrl === null ? null : pageUrl;
  });
}

/**
 * Returns the episode page URL for [number] on the anime page, or null.
 * Picks the exact number first, then the nearest lower one (fallback).
 */
export async function episodePageUrl(animePageUrl, number, options = {}) {
  return withScraperGuard(NAME, async () => {
    const { text, finalUrl } = await fetchHtml(animePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const episodes = decodeEpisodeGrid(text);
    if (episodes.length === 0) {
      return null;
    }
    const target = Number(number);
    const exact = episodes.find((entry) => entry.number === target);
    const entry = exact ?? episodes
      .filter((candidate) => candidate.number <= target)
      .sort((a, b) => b.number - a.number)[0];
    if (!entry) {
      return null;
    }
    return normalizeUrl(entry.url, finalUrl);
  });
}

/**
 * Resolves directly playable media sources from a WitAnime episode page.
 *
 * Only download-group URLs that normalize to direct media are returned.
 * Watch-server iframes decode to embed pages and are deliberately excluded:
 * the backend never bypasses embed players or anti-bot protection.
 */
export async function resolveEpisodeSources(episodePageUrl, options = {}) {
  return withScraperGuard(NAME, async () => {
    const { text, finalUrl } = await fetchHtml(episodePageUrl, {
      provider: NAME,
      timeoutMs: options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS,
    });
    const lkgx = LKGX_SCRIPT_REGEX.exec(text)?.[0] ?? null;
    if (!lkgx) {
      throw new AnimeApiError(ERROR_CODES.STREAM_UNAVAILABLE, 'WitAnime: no download payload', {
        provider: NAME,
        failureCategory: 'EXTRACTION_FAILED',
      });
    }
    const decoded = decodeDownloadUrls(lkgx);
    const sources = [];
    for (const raw of decoded) {
      const direct = toDirectStreamUrl(raw);
      if (!isSafePublicUrl(direct)) {
        continue;
      }
      const normalized = normalizeStreamSource(
        { url: direct, referer: finalUrl, origin: new URL(finalUrl).origin, label: null, quality: null },
        { providerName: NAME, language: 'sub', baseUrl: finalUrl },
      );
      if (normalized !== null) {
        sources.push(normalized);
      }
    }
    return sources;
  });
}

/** Searches the site for the best anime page match and returns it. */
function pickBestResult(html, baseUrl, query) {
  const links = extractResultLinks(html);
  if (links.length === 0) {
    return null;
  }
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) {
    return links[0];
  }
  let best = null;
  let bestScore = 0;
  for (const link of links) {
    const label = (link.label ?? '').toLowerCase();
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

function extractResultLinks(html) {
  const out = [];
  const seen = new Set();
  const patterns = [
    /<h[12][^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
    /<a[^>]+class="[^"]*(?:post-title|movie-item-title|anime-title)[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
    /<article[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = match[1].replace(/&amp;/g, '&');
      const url = normalizeUrl(href, baseUrl);
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