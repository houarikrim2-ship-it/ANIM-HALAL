/**
 * Shared infrastructure for the HTML scraper providers.
 *
 * Scrapers are the *last* link in the source-resolution chain: they only run
 * when MiruroAPI is unreachable. They fetch provider pages with browser-like
 * headers, extract only directly playable media URLs from the HTML and hand
 * them to the HLS relay. The Android client never contacts these hosts.
 *
 * Hard rules:
 * - Requests use bounded timeouts and are never retried against an anti-bot
 *   challenge (CAPTCHA/Cloudflare/...). A challenge page is classified as
 *   UPSTREAM_BLOCKED and the chain moves to the next provider. We never
 *   solve or bypass anti-bot protection.
 * - Responses are capped in size; only HTML is accepted.
 * - Extracted URLs are validated: http(s) only, and never loopback / private
 *   / link-local hosts or cloud metadata endpoints. The relay applies the
 *   same rules again at request time (defense in depth).
 */
import { ANIME_SCRAPER_TIMEOUT_MS } from '../config.js';
import { AnimeApiError, ERROR_CODES, toApiError } from '../errors.js';
import { normalizeUrl } from '../normalize.js';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_HTML_BYTES = 4 * 1024 * 1024; // 4 MiB cap per page

const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;
const LINK_LOCAL = /^169\.254\./;

/** Reserved hostnames that must never be reached by the relay or scrapers. */
const RESERVED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
]);

/**
 * Browser-like headers for scraping. Referer/Origin always match the site
 * being scraped; they are honest request metadata, not a bypass mechanism.
 */
export function browserHeaders({ referer = null, origin = null } = {}) {
  const headers = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
      'image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (referer) {
    headers.Referer = referer;
  }
  if (origin) {
    headers.Origin = origin;
  }
  return headers;
}

/**
 * True when [url] targets a host the backend is allowed to fetch. IP
 * literals are checked against the private/link-local ranges; hostnames
 * against a small reserved set. DNS-level protection is re-applied by the
 * HLS relay at request time.
 */
export function isSafePublicUrl(url) {
  const normalized = normalizeUrl(url);
  if (normalized === null) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (RESERVED_HOSTNAMES.has(hostname)) {
    return false;
  }
  if (hostname === '') {
    return false;
  }
  // IPv6 loopback / link-local / ULA / unspecified.
  if (hostname.includes(':')) {
    const addr = hostname;
    if (
      addr === '::1' ||
      addr === '::' ||
      addr.startsWith('fe80:') ||
      addr.startsWith('fc') ||
      addr.startsWith('fd') ||
      addr === '[::1]'
    ) {
      return false;
    }
    return true;
  }
  // IPv4 literals must be public.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts.some((part) => part > 255)) {
      return false;
    }
    const [a, b] = parts;
    if (a === 127 || a === 0 || (a === 169 && b === 254) || a === 10) {
      return false;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return false;
    }
    if (a === 192 && b === 168) {
      return false;
    }
  }
  return true;
}

/**
 * Fetches a provider page as HTML with bounded time and size. Throws a stable
 * [AnimeApiError] on timeout, network failure, non-HTML response, challenge
 * detection or oversized body. Retries are limited to transient network
 * failures; anti-bot responses are never retried.
 */
export async function fetchHtml(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? ANIME_SCRAPER_TIMEOUT_MS;
  const provider = options.provider ?? 'scraper';
  const referer = options.referer ?? null;
  const origin = options.origin ?? null;
  const accept = options.accept ?? null;
  // Embed hosts sometimes answer JSON (e.g. YonaPlay's player API); pass the
  // exact content types the caller is willing to parse.
  const allowedContentTypes = options.allowedContentTypes ?? [
    'text/html',
    'application/xhtml',
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  let response;
  try {
    const headers = browserHeaders({ referer, origin });
    if (accept !== null) {
      headers.Accept = accept;
    }
    console.log(`[ScraperSupport] FETCH ${url}`);
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    console.log(`[ScraperSupport] RESPONSE ${response.status} for ${url}`);
  } catch (cause) {
    clearTimeout(timer);
    if (cause?.name === 'AbortError') {
      throw new AnimeApiError(ERROR_CODES.TIMEOUT, 'Scraper request timed out', {
        provider,
        failureCategory: 'PROVIDER_TIMEOUT',
        cause,
      });
    }
    throw toApiError(cause, {
      provider,
      failureCategory: 'PROVIDER_TIMEOUT',
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, `Provider HTTP ${response.status}`, {
      provider,
      status: response.status,
      failureCategory: 'PROVIDER_UNAVAILABLE',
    });
  }
  if (response.status >= 400) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, `Provider HTTP ${response.status}`, {
      provider,
      status: response.status,
      failureCategory: 'UPSTREAM_BLOCKED',
    });
  }

  // Challenge responses are also flagged by Cloudflare-style headers without
  // needing the body; either signal is enough to refuse the page.
  const challengeHeader =
    response.headers.has('cf-challenge') || response.headers.has('cf-mitigated');

  const contentType = response.headers.get('content-type') ?? '';
  if (!allowedContentTypes.some((type) => contentType.includes(type))) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, 'Provider returned a non-HTML response', {
      provider,
      status: response.status,
      failureCategory: 'UPSTREAM_BLOCKED',
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, 'Provider body could not be read', {
      provider,
      failureCategory: 'EXTRACTION_FAILED',
      cause,
    });
  }
  if (text.length > MAX_HTML_BYTES) {
    throw new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, 'Provider page exceeded size limit', {
      provider,
      failureCategory: 'UPSTREAM_BLOCKED',
    });
  }
  if (challengeHeader || isChallengeHtml(text)) {
    throw new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, 'Provider returned an anti-bot challenge page', {
      provider,
      status: response.status,
      failureCategory: 'UPSTREAM_BLOCKED',
    });
  }
  return { text, finalUrl: response.url, status: response.status };
}

/**
 * Performs a HEAD request with a small timeout to probe the media type and
 * existence of a URL.
 */
async function headFetch(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: browserHeaders(options.headers),
      signal: controller.signal,
      redirect: 'follow',
    });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded GET/Range probe used when HEAD is unsupported or insufficient. It
 * returns the final redirected URL, the effective content-type, and a small
 * slice of body text. It never consumes the whole media file (bounded bytes
 * and a timeout). Returns null when the probe is unavailable (DNS failure,
 * refused connection, timeout) so callers can keep the candidate.
 */
async function getProbe(url, options = {}, maxBytes = 8192) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(url, {
      headers: { ...browserHeaders(options.headers), Range: `bytes=0-${maxBytes - 1}` },
      signal: controller.signal,
      redirect: 'follow',
    });
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      contentType,
      text,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when the URL or content-type looks like HLS. We check the raw URL
 * (including query string) plus known path patterns so a valid manifest is
 * never rejected merely because the URL does not end with .m3u8.
 */
function looksLikeHlsUrl(rawUrl, contentType) {
  const lowerUrl = String(rawUrl).toLowerCase();
  const lowerType = contentType ?? '';
  if (lowerType.includes('mpegurl') || lowerType.includes('apple.mpegurl') || lowerType.includes('x-mpegurl')) {
    return true;
  }
  if (lowerUrl.includes('.m3u8') || lowerUrl.includes('m3u8')) {
    return true;
  }
  return /\/(?:hls|m3u8)(?:\/|\.|$)/.test(lowerUrl) ||
    /(?:^|\/)(?:playlist|chunklist|master|index)(?:\.|\/)/.test(lowerUrl);
}

/**
 * True when the URL or content-type looks like a progressive MP4 (or related
 * webm/m4v) media resource. Extensionless URLs are accepted when they carry a
 * media-shaped path hint or a video/* content type, so real streams are never
 * dropped just because the URL does not end with .mp4.
 */
function looksLikeMp4Url(rawUrl, contentType) {
  const lowerUrl = String(rawUrl).toLowerCase();
  const lowerType = contentType ?? '';
  if (
    lowerType.includes('video/mp4') ||
    lowerType.includes('video/webm') ||
    lowerType.includes('video/x-m4v') ||
    lowerType.includes('video/quicktime')
  ) {
    return true;
  }
  if (lowerUrl.includes('.mp4') || lowerUrl.includes('.webm') || lowerUrl.includes('.m4v')) {
    return true;
  }
  return /\/(?:video|media|stream|vod|play|mp4)(?:\/|\.|$)/.test(lowerUrl);
}

/**
 * Validates whether a URL points to a playable media resource by checking
 * its headers and optionally sniffing the first few bytes.
 */
export async function validateMedia(url, options = {}) {
  if (!isSafePublicUrl(url)) return { valid: false, reason: 'UNSAFE' };

  const head = await headFetch(url, options);

  let contentType = '';
  let finalUrl = url;

  if (head !== null) {
    if (head.status === 404) return { valid: false, reason: 'NOT_FOUND' };
    // Some hosts return 403/405 for HEAD but allow GET/Range probes.
    if (head.ok) {
      contentType = (head.headers.get('content-type') ?? '').toLowerCase();
      finalUrl = head.url || url;
    }
  }

  const isHls = looksLikeHlsUrl(finalUrl, contentType);
  const isProgressive = looksLikeMp4Url(finalUrl, contentType);

  // If HEAD failed or was inconclusive, use a bounded GET probe.
  if (head === null || !head.ok || (!isHls && !isProgressive)) {
    const probe = await getProbe(url, options);
    if (probe === null) {
      // Keep inconclusive candidates if they look like media.
      if (looksLikeHlsUrl(url, '') || looksLikeMp4Url(url, '')) {
         return { valid: true, type: looksLikeHlsUrl(url, '') ? 'hls' : 'mp4', finalUrl: url, contentType: 'application/octet-stream' };
      }
      return { valid: false, reason: 'PROBE_UNAVAILABLE' };
    }
    if (probe.status === 404) return { valid: false, reason: 'NOT_FOUND' };
    if (!probe.ok) return { valid: false, reason: 'HTTP_ERROR', detail: `HTTP ${probe.status}` };

    contentType = probe.contentType;
    finalUrl = probe.url || finalUrl;
  }

  const isHlsAfter = looksLikeHlsUrl(finalUrl, contentType);
  const isProgressiveAfter = looksLikeMp4Url(finalUrl, contentType);

  if (!isHlsAfter && !isProgressiveAfter) {
    // If it's a redirect page (HTML), it's not DIRECT media.
    if (/\b(?:text\/html|application\/xhtml)\b/.test(contentType)) {
        return { valid: false, reason: 'UNSUPPORTED_TYPE', detail: 'HTML_PAGE' };
    }
    return { valid: false, reason: 'UNSUPPORTED_TYPE', detail: contentType || 'unknown' };
  }

  // HLS Sniffing
  if (isHlsAfter && options.sniff !== false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const getResponse = await fetch(finalUrl, {
        headers: { ...browserHeaders(options.headers), Range: 'bytes=0-1024' },
        signal: controller.signal,
      });
      const text = await getResponse.text();
      if (typeof text === 'string' && text.length > 0 && !text.includes('#EXTM3U')) {
        return { valid: false, reason: 'INVALID_HLS_MANIFEST' };
      }
    } catch {
      // Inconclusive sniff -> keep
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    valid: true,
    type: isHlsAfter ? 'hls' : 'mp4',
    contentType,
    finalUrl
  };
}

/**
 * Opportunistic, upgrade-only probe for scraper-direct candidates. It never
 * rejects a live candidate: a positive validation upgrades to the final URL
 * and real media type, an inconclusive probe keeps the original URL/type, and
 * only UNSAFE (security-negative) is reported as not safe for the caller to
 * drop. Set ANIME_SCRAPER_DIRECT_VALIDATION=false to bypass probing entirely.
 */
export async function opportunisticDirectProbe(url, options = {}) {
  if ((process.env.ANIME_SCRAPER_DIRECT_VALIDATION ?? 'true') === 'false') {
    return { url, type: null, safe: true };
  }
  const headers = options.headers ?? (options.referer ? { referer: options.referer } : {});
  const provider = options.provider ?? 'scraper';

  const validation = await validateMedia(url, {
    headers,
    timeoutMs: options.timeoutMs ?? 4000,
    sniff: false,
  });

  if (validation.valid) {
    console.log(`[${provider}] SOURCE_CLASSIFIED finalType=DIRECT_MEDIA playable=true reason=VALIDATION_SUCCESS contentType=${validation.contentType}`);
    return { url: validation.finalUrl || url, type: validation.type, safe: true };
  } else if (validation.reason === 'UNSAFE') {
    console.log(`[${provider}] SOURCE_CLASSIFIED finalType=DEAD playable=false reason=UNSAFE`);
    return { url, type: null, safe: false };
  } else {
    console.log(`[${provider}] SOURCE_CLASSIFIED finalType=UNRESOLVED playable=false reason=${validation.reason}`);
    return { url, type: null, safe: true };
  }
}

const CANDIDATE_FILE_REGEX =
  /["']?(?:file|src|url|v|source|file_url|stream_url)["']?\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["']/gi;

const CANDIDATE_TAG_REGEX =
  /<(?:source|video|iframe)[^>]+(?:src|data-src|data-video|data-url)=["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["']/gi;

const CANDIDATE_ATOB_REGEX = /atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g;

/** Token-scoped URLs (file/src/url/...) that may be extensionless. */
const CANDIDATE_TOKEN_REGEX =
  /["']?(?:file|src|url|v|source|file_url|stream_url|video_url|data-url|data-src|source)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi;

const MEDIA_EXT_RE = /\.(?:m3u8|mp4|webm|m4v|mkv|mov|ts)(?:[?#]|$)/i;
const NON_MEDIA_EXT_RE =
  /\.(?:js|jsx|ts|cjs|mjs|css|png|jpe?g|gif|svg|webp|ico|json|html?|php|txt|woff2?|ttf|xml|rss|zip|gz|pdf|wasm|avif|bmp|webmanifest)(?:[?#]|$)/i;
const EXTENSIONLESS_MEDIA_HINT =
  /\/(?:hls|manifest|playlist|master|video|media|stream|vod|play|mp4|m3u8)(?:\/|\.|$)|\.ts(?:\/|$)/i;

/**
 * Image and static-asset URL patterns that must NEVER be treated as playable
 * media or as a watch-server embed page. A WordPress poster image served as an
 * extensionless blob (e.g. /wp-content/uploads/2020/12/<hash>) otherwise falls
 * through extension heuristics and gets mislabeled as a server. These are
 * classified generically by path + media attributes, not by host.
 */
const STATIC_ASSET_PATH_RE =
  /\/(?:wp-content\/uploads|wp-includes|img|images?|thumbnail|thumb|poster|banner|icons?|favicon|assets?|static|build|dist|css|fonts?)\//i;
const STATIC_ASSET_EXT_RE =
  /\.(?:png|jpe?g|gif|svg|webp|ico|avif|bmp|webmanifest|css|jsx|ts|cjs|mjs|woff2?|ttf|json|xml|map)(?:[?#]|$)/i;
const DATA_IMAGE_RE = /^data:image\//i;
const IMAGE_PARAM_HINTS =
  /\b(?:poster|thumbnail|imagedelivery|imagetype|image|cover|banner|logo|favicon|screenshot|avatar)\b[=:]/i;

/**
 * True when [rawUrl] points at a navigational / site page rather than a
 * playable watch-host embed URL (iframe / download handler / streaming host).
 * Scrapers frequently pick up the site root ("/"), relative-season/detail
 * pages ("/anime/<slug>/") and taxonomy listings ("/category/", "/tag/", ...)
 * from data-* attributes and <a> links. Treating these as EMBED "servers"
 * produces useless, unplayable cards, so they are rejected before the
 * DIRECT vs EMBED split. Only unambiguous path shapes are rejected.
 */
const NAV_PAGE_PATH_RE =
  /^\/(?:$|anime\/|category\/|tag\/|series\/|genre\/|episode\/|watch\/|search\/|page\/|feed|author\/)/i;

export function isNonPlayableEmbedUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (NAV_PAGE_PATH_RE.test(parsed.pathname)) {
    return true;
  }
  // Site root / "?p=" permalink-style navigation, excluding real watch URLs.
  if (parsed.pathname === '/' && !parsed.search.includes('.m3u8')) {
    return true;
  }
  if (parsed.search.startsWith('?p=')) {
    return true;
  }
  return false;
}

/**
 * Strips/truncates a scraper label so a raw-HTML scrap (anchor tags, img
 * data-image attributes, CSS, long synopses) can never leak into the API /
 * server card. Returns a short, safe, single-line text.
 */
export function sanitizeScraperLabel(label, maxLength = 60) {
  if (typeof label !== 'string') {
    return null;
  }
  let text = label
    // Strip tags and their interleaved attributes (e.g. <a href=...>, <img class=... data-image=...>).
    .replace(/<[^>]*>/g, ' ')
    // Collapse entities to spaces then whitespace runs.
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') {
    return null;
  }
  if (text.length > maxLength) {
    text = text.slice(0, maxLength).trimEnd() + '…';
  }
  return text;
}

/**
 * Derives a canonical provider identity from a watch/download embed URL host.
 * Used so an EMBED fallback server is labeled by its real upstream provider
 * (e.g. "hgcloud", "streamwish", "playerwish", "download" for file hosts)
 * rather than by whichever scraper site discovered it.
 */
export function canonicalEmbedProvider(rawUrl) {
  let host = '';
  try {
    host = new URL(String(rawUrl).trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/premilkyway|jaketwish|streamwish|hlswish|wishplayer|streamy|stish|wishembed/.test(host)) {
    return 'streamwish';
  }
  if (/playerwish/.test(host)) {
    return 'playerwish';
  }
  if (/\.mega\.nz$|mega\.co|mega\.link/.test(host)) {
    return 'mega';
  }
  if (/workupload/.test(host)) {
    return 'workupload';
  }
  if (/pixeldrain/.test(host)) {
    return 'pixeldrain';
  }
  if (/gofile/.test(host)) {
    return 'gofile';
  }
  if (/mediafire/.test(host)) {
    return 'mediafire';
  }
  if (/kuhaku/.test(host)) {
    return 'kuhaku';
  }
  if (/generic\.php$|download\.php|\.rf\.gd|\.tf$/i.test(host) || /download/i.test(host)) {
    return 'download';
  }
  if (/hgcloud|hglink|highload/.test(host)) {
    return 'hgcloud';
  }
  if (/mp4upload/.test(host)) {
    return 'mp4upload';
  }
  if (/yonaplay/.test(host)) {
    return 'yonaplay';
  }
  if (/ok\.ru|odnoklassniki/.test(host)) {
    return 'ok.ru';
  }
  if (/videa/.test(host)) {
    return 'videa';
  }
  if (/dailymotion/.test(host)) {
    return 'dailymotion';
  }
  if (/yourupload/.test(host)) {
    return 'yourupload';
  }
  return null;
}

/**
 * True when [rawUrl] points at an image or other static asset rather than a
 * playable media stream or a watch-server embed page. Used to gate scraper
 * connection rows *before* they are split into DIRECT vs EMBED candidates, so
 * an extensionless poster blob can never become an EMBED_FALLBACK "server".
 * Conservative: only unambiguous asset signals are rejected.
 */
export function isStaticAssetUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return false;
  }
  const url = rawUrl.trim();
  if (DATA_IMAGE_RE.test(url)) {
    return true;
  }
  let path = '';
  let query = '';
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
    query = parsed.search;
  } catch {
    // Unparseable URLs are handled upstream (isSafePublicUrl / normalizeUrl);
    // treat as not-an-asset here so filtering decisions stay conservative.
    return false;
  }
  const lowerPath = path.toLowerCase();
  if (STATIC_ASSET_EXT_RE.test(lowerPath)) {
    return true;
  }
  if (STATIC_ASSET_PATH_RE.test(lowerPath)) {
    return true;
  }
  // Query-string selectors (e.g. ?imagedelivery=... or file=?poster=) without a
  // media path hint are not playable media. Only match when the whole string is
  // obviously an image fetch, avoiding false positives on real HLS token params.
  const lowerQuery = query.toLowerCase();
  return (
    IMAGE_PARAM_HINTS.test(lowerQuery) &&
    !isPlausibleMediaUrl(lowerPath) &&
    !lowerPath.includes('.m3u8')
  );
}

/**
 * True when a URL is plausibly a playable media resource, used to keep the
 * extensionless candidate pass tight. Extension-bearing URLs must be media
 * extensions; known non-media extensions are refused; extensionless URLs must
 * still carry a media-shaped path hint.
 */
function isPlausibleMediaUrl(rawUrl) {
  const path = String(rawUrl).split(/[?#]/)[0] ?? '';
  if (MEDIA_EXT_RE.test(path)) return true;
  if (NON_MEDIA_EXT_RE.test(path)) return false;
  return EXTENSIONLESS_MEDIA_HINT.test(path);
}

/**
 * Robustly extracts candidate media URLs from HTML or JS source.
 */
export function extractCandidates(source, options = {}) {
  const baseUrl = options.pageUrl ?? null;
  const out = [];
  const seen = new Set();

  const push = (rawUrl, label = null) => {
    const url = normalizeUrl(rawUrl, baseUrl);
    if (url === null || seen.has(url)) return;
    seen.add(url);
    const cleanLabel = typeof label === 'string' ? label.trim() : '';
    out.push({
        url,
        label: cleanLabel !== '' ? cleanLabel : null,
        // Keep the provider's own quality label verbatim; later pipeline
        // stages (normalizeStreamSource / the scraper layer) map it to the
        // stable quality contract.
        quality: cleanLabel !== '' ? cleanLabel : inferScraperQuality(url) || 'auto'
    });
  };

  const unpacked = unpackJs(source);
  let match;

  // 1. Quoted URLs with a media extension
  CANDIDATE_FILE_REGEX.lastIndex = 0;
  while ((match = CANDIDATE_FILE_REGEX.exec(unpacked)) !== null) {
      const window = unpacked.slice(match.index, match.index + 300);
      const labelMatch = /["']?label["']?\s*[:=]\s*["']([^"']*)["']/i.exec(window);
      push(match[1], labelMatch?.[1]);
  }

  // 2. HTML Tags
  CANDIDATE_TAG_REGEX.lastIndex = 0;
  while ((match = CANDIDATE_TAG_REGEX.exec(unpacked)) !== null) {
      push(match[1]);
  }

  // 3. Base64
  CANDIDATE_ATOB_REGEX.lastIndex = 0;
  while ((match = CANDIDATE_ATOB_REGEX.exec(unpacked)) !== null) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      if (decoded.startsWith('http')) push(decoded);
    } catch { /* skip */ }
  }

  // 4. JSON-like arrays/objects
  const arrayRe = /"(https?:\/\/[^"]+\.(?:m3u8|mp4|webm|m4v|mkv)(?:[?#][^"]*)?)"/gi;
  let arrMatch;
  while ((arrMatch = arrayRe.exec(unpacked)) !== null) {
      push(arrMatch[1]);
  }

  const singleQuotedRe = /'(https?:\/\/[^']+\.(?:m3u8|mp4|webm|m4v|mkv)(?:[?#][^']*)?)'/gi;
  while ((arrMatch = singleQuotedRe.exec(unpacked)) !== null) {
      push(arrMatch[1]);
  }

  // 5. Token-scoped URLs without a media extension (extensionless HLS/MP4
  //    served by CDNs that hide the extension from the player page).
  CANDIDATE_TOKEN_REGEX.lastIndex = 0;
  while ((match = CANDIDATE_TOKEN_REGEX.exec(unpacked)) !== null) {
    if (!isPlausibleMediaUrl(match[1])) continue;
    const window = unpacked.slice(Math.max(0, match.index - 160), match.index + 300);
    const labelMatch = /["']?label["']?\s*[:=]\s*["']([^"']*)["']/i.exec(window);
    push(match[1], labelMatch?.[1]);
  }

  return out;
}

/** Challenge markers recognized in HTML bodies; never solved or bypassed. */
export function isChallengeHtml(html) {
  if (typeof html !== 'string') {
    return false;
  }
  // Refined to avoid false positives on background challenge scripts (e.g. jsd/main.js).
  // We only block if we see the actual "Just a moment" verification page or an error page.
  return /cf-browser-verification|turnstile|captcha|just a moment|checking your browser|access denied|attention required/i.test(
    html,
  ) && !/<title>.*WitAnime.*<\/title>|<title>.*Anime4Up.*<\/title>/i.test(html);
}

/** Base64 decode tolerant of whitespace; null on invalid input. */
export function base64Decode(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const clean = value.replace(/\s+/g, '');
  if (clean.length === 0) {
    return Buffer.alloc(0);
  }
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return null;
  }
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

/**
 * XORs [data] byte-by-byte with a cyclically repeated [key], returning text.
 * Mirrors the WitAnime theme decoder byte-for-byte.
 */
export function xorDecode(data, key) {
  if (key.length === 0 || data.length === 0) {
    return '';
  }
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out.toString('latin1');
}

/** Parses a `"a","b","c"` string array literal. */
export function parseStringArray(content) {
  const out = [];
  const re = /"([^"]*)"/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    out.push(match[1]);
  }
  return out;
}

/** Parses a comma-separated integer array literal; null when non-numeric. */
export function parseIntArray(content) {
  const out = [];
  const re = /(\d+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const value = Number(match[1]);
    if (Number.isNaN(value)) {
      return null;
    }
    out.push(value);
  }
  return out;
}

/** Hex string to bytes; null when malformed. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  return Buffer.from(hex, 'hex');
}

/** Converts an HTML attribute to its literal text (decodes entities). */
export function decodeHtmlAttribute(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Maps an Arabic quality label to a stable quality string, or null. */
export function inferScraperQuality(label) {
  if (typeof label !== 'string') {
    return null;
  }
  const lower = label.toLowerCase();
  if (lower.includes('fhd') || lower.includes('1080') || lower.includes('خارقة')) {
    return '1080p';
  }
  if (lower.includes('hd') || lower.includes('720') || lower.includes('عالية')) {
    return '720p';
  }
  if (lower.includes('sd') || lower.includes('480') || lower.includes('متوسطة')) {
    return '480p';
  }
  return null;
}

/**
 * Normalizes the structurally-inconsistent results that embed resolvers return
 * (either wrapped `{ sources, error, status, extractionStatus }` objects or
 * bare source arrays) into a stable shape callers can branch on.
 */
export function normalizeEmbedResult(result) {
  if (Array.isArray(result)) {
    return { sources: result, error: null, status: null, extractionStatus: 'DIRECT' };
  }
  if (result && typeof result === 'object') {
    const sources = Array.isArray(result.sources) ? result.sources : [];
    return {
      sources,
      error: result.error ?? null,
      status: result.status ?? null,
      extractionStatus:
        result.extractionStatus ?? (sources.length > 0 ? 'DIRECT' : 'EMBED'),
    };
  }
  return { sources: [], error: 'invalid resolveEmbed result', status: null, extractionStatus: 'FAILED' };
}

/**
 * Builds the raw EMBED fallback source for a watch-server embed whose embed
 * resolver could not turn it into playable direct media (but the embed URL
 * itself remains live). Keeps the episode watchable through the player's
 * embedded-web mode. Callers pass it through normalizeStreamSource with
 * `allowEmbeds: true`.
 */
export function embedFallbackSource(embed, providerName) {
  return {
    url: embed.url,
    name: embed.name ?? providerName,
    quality: 'auto',
    isEmbed: true,
    type: 'embed',
    provider: providerName,
    embedUrl: embed.url,
    embedName: embed.name ?? providerName,
  };
}

/** Normalizes a title for search matching (lowercased, punctuation removed). */
export function normalizeTitle(title) {
  if (typeof title !== 'string') {
    return '';
  }
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Calculates a match score for a candidate title against a query. */
export function calculateTitleScore(query, candidate) {
  const normQuery = normalizeTitle(query);
  const normCandidate = normalizeTitle(candidate);

  if (normQuery === normCandidate) return 100;

  const queryTokens = normQuery.split(/\s+/).filter(Boolean);
  const candidateTokens = normCandidate.split(/\s+/).filter(Boolean);

  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  let score = 0;
  let matches = 0;

  for (const q of queryTokens) {
    if (candidateTokens.includes(q)) {
      matches++;
      score += 10;
    }
  }

  if (matches === 0) return 0;

  // Penalty for extra words in candidate (prevents "Naruto" matching "Boruto: Naruto Next Generations")
  score -= (candidateTokens.length - matches) * 5;

  // Penalty for missing words from query
  score -= (queryTokens.length - matches) * 10;

  // Penalty for common sequels/spinoffs that are not in the query (prevents "Naruto" matching "Boruto")
  const commonSequels = ['boruto', 'shippuden', 'gaiden', 'movie', 'film', 'ova', 'special', 'recap'];
  for (const sequel of commonSequels) {
    if (normCandidate.includes(sequel) && !normQuery.includes(sequel)) {
      score -= 40;
    }
  }

  // Bonus for same start
  if (normCandidate.startsWith(normQuery)) {
    score += 5;
  }

  // Exact word sequence bonus
  if (normCandidate.includes(normQuery)) {
    score += 10;
  }

  return score;
}

/**
 * Lightweight JavaScript unpacker for `eval(function(p,a,c,k,e,d)...)` blocks.
 * Returns the unpacked source string, or the original if not packed.
 */
export function unpackJs(code) {
  if (typeof code !== 'string') return '';
  const match = /eval\(function\(p,a,c,k,e,d\)\{.*?return p\}\((['"])(.*?)\1,(\d+),(\d+),(['"])(.*?)\4\.split\((['"])\|\7\)\)\)/.exec(code);
  if (!match) return code;

  let p = match[2];
  let a = parseInt(match[3], 10);
  if (a <= 1) return code; // Guard against infinite recursion if base is 1 or less
  let c = parseInt(match[4], 10);
  let k = match[6];
  const keywords = k.split('|');

  const e = (val) => {
    return (val < a ? '' : e(Math.floor(val / a))) + ((val %= a) > 35 ? String.fromCharCode(val + 29) : val.toString(36));
  };

  const d = {};
  while (c--) {
    d[e(c)] = keywords[c] || e(c);
  }

  return p.replace(/\b(\w+)\b/g, (w) => d[w] || w);
}

/**
 * Runs [fn] and normalizes any failure into an [AnimeApiError] with the
 * provider name and a structured failure category attached. Scraper internals
 * never escape this boundary.
 */
export async function withScraperGuard(providerName, fn, context = {}) {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof AnimeApiError) {
      throw new AnimeApiError(cause.code, cause.message, {
        provider: providerName,
        status: cause.status,
        failureCategory: cause.failureCategory ?? cause.code,
        cause: cause.cause,
      });
    }
    throw toApiError(cause, {
      provider: providerName,
      failureCategory: 'EXTRACTION_FAILED',
    });
  }
}
