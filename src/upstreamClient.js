import { Readable } from 'node:stream';
import {
  isForbiddenAddress,
  isHostAllowed,
  UPSTREAM_MAX_REDIRECTS,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_USER_AGENT,
} from './config.js';

export class UpstreamError extends Error {
  constructor(code, status, message, cause) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Authorizes a parsed URL for upstream use: http(s) only, no embedded
 * credentials, hostname normalized (lowercase, trailing-dot root alias
 * stripped), forbidden addresses (localhost/loopback/private/internal/IP)
 * rejected, and the host must pass the boundary-aware allowlist. Used for
 * both the initial target and every redirect hop.
 */
function assertAllowedUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError('E_INVALID_URL', 400, 'Only http:// and https:// upstream URLs are allowed');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UpstreamError('E_INVALID_URL', 400, 'Upstream URL must not contain embedded credentials');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isForbiddenAddress(host)) {
    throw new UpstreamError('E_UNAUTHORIZED_HOST', 403, 'Upstream host is a forbidden address');
  }
  if (!isHostAllowed(host)) {
    throw new UpstreamError('E_UNAUTHORIZED_HOST', 403, 'Upstream host is not on the allowed list');
  }
}

export function validateUpstreamUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamError('E_INVALID_URL', 400, 'Upstream URL is not a valid URL');
  }
  assertAllowedUrl(url);
  return url;
}

function resolveRedirectTarget(location, fromUrl) {
  let next;
  try {
    next = new URL(location, fromUrl);
  } catch {
    throw new UpstreamError('E_INVALID_URL', 400, 'Upstream redirect target is not a valid URL');
  }
  assertAllowedUrl(next);
  return next;
}

function guardBodyStream(webStream, maxBytes) {
  if (!Number.isFinite(maxBytes)) {
    return webStream;
  }
  let seen = 0;
  const transformer = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new UpstreamError('E_TOO_LARGE', 413, 'Upstream response exceeds the configured size limit')
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return webStream.pipeThrough(transformer);
}

function bindClientDisconnect(req, res, controller, onAbort) {
  function onAborted() {
    onAbort();
  }
  function onReqClose() {
    if (!req.complete) {
      onAbort();
    }
  }
  function onResClose() {
    if (!res.writableEnded) {
      onAbort();
    }
  }
  req.once('aborted', onAborted);
  req.once('close', onReqClose);
  res.once('close', onResClose);
  return () => {
    req.removeListener('aborted', onAborted);
    req.removeListener('close', onReqClose);
    res.removeListener('close', onResClose);
  };
}

export async function fetchUpstream(req, res, sourceUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? UPSTREAM_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? Infinity;
  // Static, honest request headers. The relay identifies itself; it never
  // impersonates a browser and never injects Referer/Origin/Cookie/Authorization
  // headers to evade upstream anti-bot controls. A CAPTCHA or anti-bot wall is
  // treated as an unavailable source, not as a condition to bypass.
  const headers = {
    ...(options.headers ?? {}),
    'Accept': '*/*',
    'User-Agent': UPSTREAM_USER_AGENT,
  };


  const controller = new AbortController();
  let disconnected = false;
  let aborted = false;

  const abortUpstream = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    controller.abort();
  };

  const cleanup = bindClientDisconnect(req, res, controller, () => {
    disconnected = true;
    abortUpstream();
  });

  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      abortUpstream();
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  try {
    let url = validateUpstreamUrl(sourceUrl);
    let response = null;
    let redirects = 0;
    const visited = new Set([url.href]);

    while (true) {
      response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        break;
      }

      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        break;
      }

      if (redirects >= maxRedirects) {
        throw new UpstreamError('E_REDIRECT_LOOP', 502, 'Upstream exceeded the maximum redirect limit');
      }

      const next = resolveRedirectTarget(location, url);
      if (visited.has(next.href)) {
        throw new UpstreamError('E_REDIRECT_LOOP', 502, 'Upstream redirect loop detected');
      }
      visited.add(next.href);
      url = next;
      redirects += 1;
    }

    // Anti-bot walls are detected BEFORE any body is read. A CAPTCHA or
    // Cloudflare challenge is treated as an unavailable source (502), never
    // as a condition to bypass — the challenge body is dropped, not relayed.
    if (response.headers.get('cf-mitigated') || response.headers.get('cf-challenge')) {
      await response.body?.cancel();
      throw new UpstreamError('E_BAD_UPSTREAM', 502, 'Upstream presented an anti-bot challenge');
    }

    const stream =
      response.ok && response.body
        ? Readable.fromWeb(guardBodyStream(response.body, maxBytes))
        : null;

    return { response, stream };
  } catch (err) {
    if (err instanceof UpstreamError) {
      throw err;
    }
    if (err?.name === 'AbortError') {
      if (disconnected) {
        throw new UpstreamError('E_CLIENT_DISCONNECT', 499, 'Client disconnected');
      }
      throw new UpstreamError('E_TIMEOUT', 504, 'Upstream request timed out');
    }
    throw new UpstreamError('E_UNREACHABLE', 502, 'Upstream origin is unreachable', err);
  } finally {
    cleanup();
    if (timer) {
      clearTimeout(timer);
    }
  }
}