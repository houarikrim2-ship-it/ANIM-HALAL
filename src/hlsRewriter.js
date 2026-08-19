import { MAX_SRC_BYTES } from './config.js';
import { UpstreamError, validateUpstreamUrl } from './upstreamClient.js';

const SRC_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_DECODED_SRC_BYTES = MAX_SRC_BYTES * 4; // base64url expands ~4/3, allow slack

/**
 * Playback headers the relay may forward upstream. Restricted to the
 * honestly-declared embed context (the page that embeds the media) captured
 * by the source-resolution layer. Authentication credentials, cookies and
 * private tokens are never accepted.
 */
export const PLAYBACK_HEADER_KEYS = Object.freeze(['Referer', 'Origin']);
const MAX_HEADER_VALUE_BYTES = 1024;

export function encodeSrc(rawUrl) {
  return Buffer.from(rawUrl, 'utf8').toString('base64url');
}

/**
 * Encodes an upstream media URL — and optionally its playback headers — as
 * the relay's `src` parameter. Bare URLs keep the original format; sources
 * with playback headers are encoded as base64url(JSON {url, headers}) with
 * only allowlisted, URL-valued headers included.
 */
export function encodeSrcRef(rawUrl, headers = null) {
  if (headers === null || typeof headers !== 'object') {
    return encodeSrc(rawUrl);
  }
  const safe = {};
  for (const key of PLAYBACK_HEADER_KEYS) {
    const value = headers[key];
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        continue;
      }
      // Origin is serialized without a trailing slash (header semantics);
      // Referer keeps its full path.
      const normalized = key === 'Origin' ? parsed.origin : parsed.href;
      if (Buffer.byteLength(normalized, 'utf8') > MAX_HEADER_VALUE_BYTES) {
        continue;
      }
      safe[key] = normalized;
    } catch {
      // header value is not a usable URL; skip
    }
  }
  if (Object.keys(safe).length === 0) {
    return encodeSrc(rawUrl);
  }
  return Buffer.from(JSON.stringify({ url: rawUrl, headers: safe }), 'utf8').toString('base64url');
}

/** Extracts {url, headers} from a decoded src payload. */
function parseSrcPayload(raw) {
  let payload = raw;
  if (raw.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UpstreamError('E_INVALID_SRC', 400, 'src payload is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UpstreamError('E_INVALID_SRC', 400, 'src payload must be a JSON object');
    }
    if (typeof parsed.url !== 'string' || parsed.url.trim() === '') {
      throw new UpstreamError('E_INVALID_SRC', 400, 'src payload is missing the url field');
    }
    payload = parsed.url;
    const headers = {};
    for (const key of PLAYBACK_HEADER_KEYS) {
      const value = parsed.headers?.[key];
      if (typeof value !== 'string' || value.trim() === '') {
        continue;
      }
      let url;
      try {
        url = new URL(value.trim());
      } catch {
        throw new UpstreamError('E_INVALID_SRC', 400, `Playback header "${key}" is not a valid URL`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UpstreamError('E_INVALID_SRC', 400, `Playback header "${key}" must be an http(s) URL`);
      }
      if (Buffer.byteLength(url.href, 'utf8') > MAX_HEADER_VALUE_BYTES) {
        throw new UpstreamError('E_INVALID_SRC', 400, `Playback header "${key}" is too large`);
      }
      headers[key] = url.href;
    }
    for (const key of Object.keys(parsed.headers ?? {})) {
      if (!PLAYBACK_HEADER_KEYS.includes(key)) {
        throw new UpstreamError('E_INVALID_SRC', 400, `Playback header "${key}" is not allowed`);
      }
    }
    return { url: payload, headers };
  }
  return { url: payload, headers: {} };
}

export function decodeSrc(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new UpstreamError('E_INVALID_SRC', 400, 'Missing or empty src parameter');
  }
  if (ref.length > MAX_DECODED_SRC_BYTES) {
    throw new UpstreamError('E_INVALID_SRC', 400, 'src parameter is too large');
  }
  if (!SRC_PATTERN.test(ref)) {
    throw new UpstreamError('E_INVALID_SRC', 400, 'src parameter must be base64url');
  }
  const raw = Buffer.from(ref, 'base64url').toString('utf8');
  if (raw.length === 0 || raw.length > MAX_SRC_BYTES) {
    throw new UpstreamError('E_INVALID_SRC', 400, 'src parameter decodes to an oversized URL');
  }
  return raw;
}

export function validateSourceRef(ref) {
  const raw = decodeSrc(ref);
  const { url, headers } = parseSrcPayload(raw);
  return { url: validateUpstreamUrl(url), headers };
}

export function resolveUpstreamUrl(uri, manifestUrl) {
  let url;
  try {
    url = new URL(uri, manifestUrl);
  } catch {
    throw new UpstreamError('E_INVALID_URL', 400, 'Invalid URI in upstream playlist');
  }
  return url;
}

export function looksLikePlaylist(url) {
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) {
    return true;
  }
  const type = (url.searchParams.get('type') ?? '').toLowerCase();
  return type === 'playlist' || type === 'master' || type === 'variant';
}

const TAG_ROUTES = {
  '#EXT-X-KEY': 'key',
  '#EXT-X-SESSION-KEY': 'key',
  '#EXT-X-MAP': 'segment',
  '#EXT-X-PART': 'segment',
  '#EXT-X-PRELOAD-HINT': 'segment',
  '#EXT-X-IMAGE-STREAM-INF': 'segment',
  '#EXT-X-MEDIA': 'master',
  '#EXT-X-I-FRAME-STREAM-INF': 'master',
  '#EXT-X-RENDITION-REPORT': 'master',
};

export function buildRelayPath(kind, upstreamUrl, srcHeaders = null) {
  const encoded = encodeSrcRef(upstreamUrl.href, srcHeaders);
  if (kind === 'key') {
    return `/key?src=${encoded}`;
  }
  if (kind === 'segment') {
    return `/segment?src=${encoded}`;
  }
  return `/master.m3u8?src=${encoded}`;
}

function routeForUrl(url) {
  return looksLikePlaylist(url) ? 'master' : 'segment';
}

function tryResolve(uri, manifestUrl) {
  try {
    return resolveUpstreamUrl(uri, manifestUrl);
  } catch {
    return null;
  }
}

function rewriteUriAttr(uri, manifestUrl, kind, srcHeaders) {
  const resolved = tryResolve(uri, manifestUrl);
  if (!resolved) {
    return uri;
  }
  return buildRelayPath(kind, resolved, srcHeaders);
}

export function rewriteManifest(text, manifestUrl, srcHeaders = null) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  const out = [];
  let pendingVariant = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.push(line);
      pendingVariant = true;
      continue;
    }

    const tagName = line.split(':', 1)[0];
    const tagRoute = TAG_ROUTES[tagName];
    if (tagRoute) {
      out.push(
        line.replace(/URI="([^"]*)"/g, (_match, uri) => {
          const rewritten = rewriteUriAttr(uri, manifestUrl, tagRoute, srcHeaders);
          return `URI="${rewritten}"`;
        })
      );
      pendingVariant = false;
      continue;
    }

    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }

    if (line.trim() === '') {
      out.push(line);
      continue;
    }

    const resolved = tryResolve(line, manifestUrl);
    if (!resolved) {
      out.push(line);
    } else {
      const kind = pendingVariant ? 'master' : routeForUrl(resolved);
      out.push(buildRelayPath(kind, resolved, srcHeaders));
    }
    pendingVariant = false;
  }

  return out.join('\n');
}