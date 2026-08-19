/**
 * StreamWish embed extractor (streamwish.com / streamwish.to).
 *
 * The embed page (`/e/{id}`) initializes a player whose config lists the
 * direct media URLs. Known shapes:
 *
 *   jwplayer("player").setup({ sources: [{ file: "https://...index.m3u8",
 *                                          label: "FHD" }] })
 *   player.src = { file: "https://...mp4", type: "mp4" }
 *   new Clappr.Player({ sources: ["https://.../index.m3u8"] })
 *   videojs(...).src({ src: "https://...m3u8" })
 *
 * Extraction is pure regex on the page text; every candidate is validated
 * downstream (http(s) only, direct media suffix, no private hosts) and the
 * relay re-checks the host at playback time. Challenge/obfuscated payloads
 * simply yield no candidates and the server is omitted.
 */
import { normalizeUrl } from '../anime/normalize.js';

export const id = 'streamwish';

const HOST_PATTERNS = [
  /(?:^|[/.])streamwish\.(?:com|to|pro)(?::\d+)?(?:\/|$)/i,
];

// Matches `"file": "..."` (JSON), `file: "..."` (JS) and `src="..."` (HTML).
const FILE_ENTRY_REGEX =
  /["']?(?:file|src)["']?\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"']*)?)["']/gi;

const SOURCES_ARRAY_REGEX =
  /sources\s*:\s*\[([^\]]*)\]/gi;

/** True when [url] points at a StreamWish embed page. */
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
    const quality = inferLabel(label) ?? inferLabel(url);
    out.push({ url, label: label ?? null, quality });
  };

  // jwplayer / videojs / wishplayer `{ file: ..., label: ... }` entries.
  let match;
  FILE_ENTRY_REGEX.lastIndex = 0;
  while ((match = FILE_ENTRY_REGEX.exec(html)) !== null) {
    const window = html.slice(match.index, match.index + 240);
    const labelMatch = /["']?label["']?\s*:\s*["']([^"']*)["']/i.exec(window);
    push(match[1], labelMatch?.[1] ?? null);
  }

  // Clappr-style `sources: ["https://...m3u8", ...]` arrays.
  SOURCES_ARRAY_REGEX.lastIndex = 0;
  while ((match = SOURCES_ARRAY_REGEX.exec(html)) !== null) {
    const arrayMatch = /"([^"]+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"]*)?)"/gi.exec(match[1]);
    if (arrayMatch) {
      push(arrayMatch[1]);
    }
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
  if (lower.includes('sd') || lower.includes('480')) {
    return 'SD';
  }
  return null;
}