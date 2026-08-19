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
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
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
    await response.body?.cancel();
    throw new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, `Provider HTTP ${response.status}`, {
      provider,
      status: response.status,
      failureCategory: 'PROVIDER_UNAVAILABLE',
    });
  }
  if (response.status >= 400) {
    await response.body?.cancel();
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
    await response.body?.cancel();
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

/** Challenge markers recognized in HTML bodies; never solved or bypassed. */
export function isChallengeHtml(html) {
  if (typeof html !== 'string') {
    return false;
  }
  return /cf-browser-verification|challenge-platform|turnstile|captcha|cloudflare|just a moment|checking your browser|access denied|attention required/i.test(
    html,
  );
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