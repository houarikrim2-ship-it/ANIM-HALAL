import { MAX_SRC_BYTES } from './config.js';
import { UpstreamError, validateUpstreamUrl } from './upstreamClient.js';

const SRC_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_DECODED_SRC_BYTES = MAX_SRC_BYTES * 4; // base64url expands ~4/3, allow slack

export function encodeSrc(rawUrl) {
  return Buffer.from(rawUrl, 'utf8').toString('base64url');
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
  return validateUpstreamUrl(raw);
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

export function buildRelayPath(kind, upstreamUrl) {
  const encoded = encodeSrc(upstreamUrl.href);
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

function rewriteUriAttr(uri, manifestUrl, kind) {
  const resolved = tryResolve(uri, manifestUrl);
  if (!resolved) {
    return uri;
  }
  return buildRelayPath(kind, resolved);
}

export function rewriteManifest(text, manifestUrl) {
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
          const rewritten = rewriteUriAttr(uri, manifestUrl, tagRoute);
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
      out.push(buildRelayPath(kind, resolved));
    }
    pendingVariant = false;
  }

  return out.join('\n');
}