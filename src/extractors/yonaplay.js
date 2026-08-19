/**
 * YonaPlay embed extractor (yonaplay.net/embed.php?id={id}).
 *
 * YonaPlay's player API answers with JSON. The WitAnime theme appends the
 * framework API key (`?id=...&apiKey=...`) to yonaplay embeds; without the
 * key the API refuses to resolve the stream. The Android client applies the
 * same key, so the backend mirrors that behavior when the key is missing.
 *
 * Response shapes handled:
 *   { "success": true, "data": { "file": "https://.../index.m3u8", ... } }
 *   { "content": "...", "sources": [ { "file": "https://...m3u8" } ] }
 *   { "file": "https://...mp4" }
 *   HTML fallback: `"file": "https://...m3u8"` inside inline scripts.
 *
 * Extraction is pure regex / JSON parsing; candidates are validated
 * downstream and the relay re-checks hosts at playback time.
 */
import { normalizeUrl } from '../anime/normalize.js';

export const id = 'yonaplay';

/** The player API answers with JSON (or occasionally inline-script HTML). */
export const accept = 'application/json, text/plain, */*';
export const allowedContentTypes = ['text/html', 'application/json', 'text/plain'];

/** Fixed framework key the WitAnime theme appends (same as the Android app). */
export const YONAPLAY_API_KEY = '9933bd27-92ea-4ee9-807d-e612029d6318';

const HOST_PATTERNS = [
  /(?:^|[/.])yonaplay\.net(?::\d+)?(?:\/|$)/i,
];

const EMBED_PATTERN = /^https:\/\/yonaplay\.net\/embed\.php\?id=\d+$/i;

const JSON_FILE_REGEX =
  /["']?(?:file|src|url)["']?\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["']/gi;

/** True when [url] points at a YonaPlay embed page. */
export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

/** Appends the framework API key to yonaplay embed URLs that lack one. */
export function withApiKey(url) {
  if (!EMBED_PATTERN.test(url)) {
    return url;
  }
  return url.includes('apiKey=') ? url : `${url}&apiKey=${YONAPLAY_API_KEY}`;
}

/**
 * Extracts direct media candidates from the player API response (JSON or
 * inline-script HTML).
 *
 * @param {string} html    response text (JSON or HTML)
 * @param {object} context { pageUrl }
 * @returns {Array<{url: string, label: string|null, quality: string|null}>}
 */
export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = [];
  const seen = new Set();
  const push = (rawUrl, label = null) => {
    // Only direct-media candidates may leave the extractor; the registry
    // re-validates host + suffix on every candidate.
    if (!/\.(?:m3u8|mp4|webm|m4v)(?:[?#]|$)/i.test(rawUrl)) {
      return;
    }
    const url = normalizeUrl(rawUrl, baseUrl);
    if (url === null || seen.has(url)) {
      return;
    }
    seen.add(url);
    out.push({ url, label, quality: inferLabel(label) });
  };

  // JSON path: walk common envelopes without trusting their shape.
  try {
    const parsed = JSON.parse(html);
    for (const value of collectFileValues(parsed)) {
      if (typeof value === 'string') {
        push(value);
      }
    }
  } catch {
    // Not JSON (or JSON with inline comments) -> regex fallback below.
  }

  // Regex fallback (also covers HTML pages with inline configs).
  let match;
  JSON_FILE_REGEX.lastIndex = 0;
  while ((match = JSON_FILE_REGEX.exec(html)) !== null) {
    push(match[1]);
  }

  return out;
}

function collectFileValues(node) {
  const found = [];
  if (Array.isArray(node)) {
    for (const entry of node) {
      found.push(...collectFileValues(entry));
    }
    return found;
  }
  if (node === null || typeof node !== 'object') {
    return found;
  }
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'file' || key === 'src' || key === 'url') && typeof value === 'string') {
      found.push(value);
    } else {
      found.push(...collectFileValues(value));
    }
  }
  return found;
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