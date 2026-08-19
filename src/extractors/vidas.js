/**
 * Vidas embed extractor (vidas.su / vida.su).
 *
 * The player page exposes the direct stream inside a player config object or
 * a media element. Known shapes:
 *
 *   player_config = { ... "file": "https://.../index.m3u8" ... };
 *   var player = { "sources": [ { "src": "https://...m3u8",
 *                                 "type": "application/x-mpegURL" } ] };
 *   <video ... src="https://...mp4" ...></video>
 *   <source src="https://...m3u8" type="application/x-mpegURL">
 *
 * Extraction is regex-only; candidates are validated downstream and the
 * relay re-checks hosts at playback time. No bypass of anti-bot walls: a
 * challenge page yields no candidates and the server is omitted.
 */
import { normalizeUrl } from '../anime/normalize.js';

export const id = 'vidas';

const HOST_PATTERNS = [
  /(?:^|[/.])vidas?\.su(?::\d+)?(?:\/|$)/i,
];

// Matches `"file": "..."` (JSON), `file: "..."` (JS) and `src="..."` (HTML).
const FILE_ENTRY_REGEX =
  /["']?(?:file|src)["']?\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["']/gi;

const SOURCE_ELEMENT_REGEX =
  /<source[^>]+src=["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["'][^>]*>/gi;

const VIDEO_ELEMENT_REGEX =
  /<video[^>]+src=["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["']/gi;

/** True when [url] points at a Vidas embed page. */
export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Extracts direct media candidates from the embed page HTML.
 *
 * @param {string} html    embed page text
 * @param {object} context { pageUrl }
 * @returns {Array<{url: string, label: string|null, quality: string|null}>}
 */
export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = [];
  const seen = new Set();
  const push = (rawUrl, label = null) => {
    const url = normalizeUrl(rawUrl, baseUrl);
    if (url === null || seen.has(url)) {
      return;
    }
    seen.add(url);
    out.push({ url, label, quality: inferLabel(label) });
  };

  let match;
  FILE_ENTRY_REGEX.lastIndex = 0;
  while ((match = FILE_ENTRY_REGEX.exec(html)) !== null) {
    push(match[1]);
  }
  SOURCE_ELEMENT_REGEX.lastIndex = 0;
  while ((match = SOURCE_ELEMENT_REGEX.exec(html)) !== null) {
    push(match[1]);
  }
  VIDEO_ELEMENT_REGEX.lastIndex = 0;
  while ((match = VIDEO_ELEMENT_REGEX.exec(html)) !== null) {
    push(match[1]);
  }
  return out;
}

function inferLabel(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower.includes('fhd') || lower.includes('1080')) {
    return 'FHD';
  }
  if (lower.includes('hd') || lower.includes('720')) {
    return 'HD';
  }
  return null;
}