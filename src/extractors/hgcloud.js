/**
 * HGCloud / HGLink / HighLoad dedicated extractor.
 *
 * These hosts power many Arabic-subbed player pages and rely on three shapes
 * that a plain candidate scan misses:
 *   1. packed `eval(function(p,a,c,k,e,d)...)` loaders → unpack and re-scan,
 *   2. a `b n = { "0": "<base64>", ... }` dictionary whose values assemble the
 *      real stream URL once decoded and concatenated in key order,
 *   3. `atob("...") + atob("...")` fragment chains building an http(s) URL.
 *
 * All output flows through the shared candidate pipeline (extractCandidates)
 * so normalization, dedupe and the later validation layers stay identical to
 * every other extractor.
 */
import { inferScraperQuality, extractCandidates, unpackJs, base64Decode } from '../anime/providers/scraperSupport.js';
import { normalizeUrl, isDirectMediaUrl } from '../anime/normalize.js';
import { resolveAll } from './resolver.js';

export const id = 'hgcloud';

const HOST_PATTERNS = [
  /(?:^|[/.])hgcloud\.to(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])hglink\.to(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])hfcloud\.(?:to|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])highload\.(?:to|it|link)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])hdload\.to(?::\d+)?(?:\/|$)/i,
];

/** True when [url] points at an HGCloud-family embed page. */
export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = extractCandidates(html, { pageUrl: baseUrl });
  const seen = new Set(out.map((candidate) => candidate.url));

  const pushUrl = (raw, label = null, opts = {}) => {
    const url = normalizeUrl(raw, baseUrl);
    if (url === null || seen.has(url)) return;
    if (opts.extensionless === true) {
      // Extensionless media behind tokens: the resolver shapes the type from
      // the URL / probe, so only plausibility is required here.
      if (!isPlausibleMediaRef(raw)) return;
    } else if (!isDirectMediaUrl(url)) {
      return;
    }
    seen.add(url);
    out.push({ url, label: label ?? null, quality: inferScraperQuality(label) ?? 'auto' });
  };

  // 1. Packed loaders: unpack once and re-scan a second expanded pass.
  try {
    const unpacked = unpackJs(html);
    if (typeof unpacked === 'string' && unpacked !== html) {
      for (const candidate of extractCandidates(unpacked, { pageUrl: baseUrl })) {
        pushUrl(candidate.url, candidate.label);
      }
    }
  } catch { /* defensive: candidate scan must never throw */ }

  // 2. `<div id="player" data-source=...>` / `data-file` extensionless
  //    attributes (HGCloud serves extensionless media behind tokens).
  try {
    const attrRe = /(?:data-)(?:source|file|src|video|stream|url)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
    let attrMatch;
    while ((attrMatch = attrRe.exec(html)) !== null) {
      if (isPlausibleMediaRef(attrMatch[1])) {
        pushUrl(attrMatch[1], null, { extensionless: true });
      }
    }
  } catch { /* defensive */ }

  // 3. `b n = { "0": base64, "1": base64, ... }` dictionary assembly.
  try {
    const dictReGeneric = /\{\s*["']\d+["']\s*:\s*["'][A-Za-z0-9+/=]+["']\s*(?:,\s*["']\d+["']\s*:\s*["'][A-Za-z0-9+/=]+["']\s*)*\}/g;
    dictReGeneric.lastIndex = 0;
    let dictMatch;
    while ((dictMatch = dictReGeneric.exec(html)) !== null) {
      const entries = [];
      const entryRe = /["'](\d+)["']\s*:\s*["']([A-Za-z0-9+/=]+)["']/g;
      let entry;
      while ((entry = entryRe.exec(dictMatch[0])) !== null) {
        const decoded = base64Decode(entry[2]);
        if (decoded !== null) {
          entries.push([Number(entry[1]), decoded.toString('utf8')]);
        }
      }
      if (entries.length > 1) {
        const assembled = entries
          .sort((a, b) => a[0] - b[0])
          .map(([, chunk]) => chunk)
          .join('');
        if (/^https?:\/\//i.test(assembled)) {
          pushUrl(assembled);
        }
      }
    }
  } catch { /* defensive */ }
  // 4. `atob("...") + atob("...") + ...` fragments assembling a URL.
  try {
    const chainRe = new RegExp('(?:atob\\s*\\(\\s*["\\\']([A-Za-z0-9+/=]+)["\\\']\\s*\\)\\s*\\+?\\s*){2,}', 'gi');
    let chainMatch;
    while ((chainMatch = chainRe.exec(html)) !== null) {
      const assembled = [];
      const fragRe = /atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g;
      fragRe.lastIndex = 0;
      let frag;
      while ((frag = fragRe.exec(chainMatch[0])) !== null) {
        const decoded = base64Decode(frag[1]);
        if (decoded === null) {
          assembled.length = 0;
          break;
        }
        assembled.push(decoded.toString('utf8'));
      }
      if (assembled.length > 0 && /^https?:\/\//i.test(assembled.join(''))) {
        pushUrl(assembled.join(''));
      }
    }
  } catch { /* defensive */ }

  return out;
}

const MEDIA_EXT_RE = /\.(?:m3u8|mp4|webm|m4v)(?:[?#]|$)/i;
const NON_MEDIA_EXT_RE =
  /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|json|html?|php|txt|woff2?|ttf)(?:[?#]|$)/i;
const MEDIA_PATH_HINT = /(?:^|\/)(?:hls|media|stream|video|play|vod)(?:\/|\.|$)|\.ts(?:\/|$)/i;

function isPlausibleMediaRef(raw) {
  const path = String(raw).split(/[?#]/)[0] ?? '';
  if (MEDIA_EXT_RE.test(path)) return true;
  if (NON_MEDIA_EXT_RE.test(path)) return false;
  return MEDIA_PATH_HINT.test(path);
}