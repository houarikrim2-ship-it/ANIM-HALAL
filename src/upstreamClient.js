import dns from 'node:dns';
import { Readable } from 'node:stream';
import { Agent } from 'undici';
import {
  isForbiddenAddress,
  isHostAllowed,
  providerHeadersFor,
  UPSTREAM_ALLOW_PRIVATE_RESOLUTION,
  UPSTREAM_MAX_REDIRECTS,
  UPSTREAM_RETRY_BASE_DELAY_MS,
  UPSTREAM_RETRY_MAX_ATTEMPTS,
  UPSTREAM_RETRY_MAX_DELAY_MS,
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
 * Transient upstream outcomes worth retrying (spec §12): rate limiting,
 * timeouts and server-side failures. 400/401/403/404/416 and client
 * disconnects are never retried — they are deterministic or pointless.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

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

// ── Post-DNS SSRF validation (spec §5) ──────────────────────────────────────

/**
 * Normalizes a hostname for DNS cache keys: lowercase, trailing-dot root
 * alias stripped (mirrors the allowlist checks).
 */
function normHost(hostname) {
  return String(hostname ?? '').toLowerCase().replace(/\.$/, '');
}

/**
 * Resolves [hostname] via node:dns.lookup (callback API, so test harnesses
 * that stub dns.lookup keep working). Returns all addresses.
 */
function lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(addresses.map((entry) => entry.address));
    });
  });
}

/**
 * Post-DNS validation: keeps only resolved addresses that pass the same
 * forbidden-address rules as the URL hostname itself. When EVERY resolved
 * address is forbidden the host is refused outright (403) unless the
 * server-side test override [UPSTREAM_ALLOW_PRIVATE_RESOLUTION] is set.
 * Exported for unit tests.
 */
export function selectAllowedAddresses(hostname, addresses) {
  const allowed = addresses.filter((address) => !isForbiddenAddress(address));
  if (allowed.length === 0 && !UPSTREAM_ALLOW_PRIVATE_RESOLUTION) {
    throw new UpstreamError(
      'E_UNAUTHORIZED_HOST',
      403,
      `Upstream host ${hostname} resolves only to forbidden addresses`
    );
  }
  return UPSTREAM_ALLOW_PRIVATE_RESOLUTION ? addresses : allowed;
}

/**
 * Resolves + validates [hostname] and caches the outcome per hostname.
 * Connections are then PINNED to these exact validated addresses via
 * [pinnedDispatcher], so the address actually contacted is always the one
 * that passed validation (no DNS-rebinding window between validation and
 * connect). A failed resolution is evicted so the next attempt re-resolves.
 */
const resolutionCache = new Map();

async function assertResolvedAllowed(hostname) {
  const key = normHost(hostname);
  const cached = resolutionCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const promise = (async () => {
    const addresses = await lookupAll(key);
    if (addresses.length === 0) {
      throw new UpstreamError('E_UNREACHABLE', 502, `Upstream host ${key} did not resolve to any address`);
    }
    return selectAllowedAddresses(key, addresses);
  })();
  resolutionCache.set(key, promise);
  try {
    await promise;
  } catch (err) {
    resolutionCache.delete(key);
    throw err;
  }
  return promise;
}

/** Dispatcher whose connections only ever use pre-validated addresses. */
const pinnedDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      const entry = resolutionCache.get(normHost(hostname));
      if (entry === undefined) {
        callback(new Error('E_RESOLVED_FORBIDDEN: host was not validated before connect'), null);
        return;
      }
      entry.then(
        (addresses) => {
          const family = (options?.family ?? 0) || undefined;
          const usable = family === undefined
            ? addresses
            : addresses.filter((address) => address.includes(':') === (family === 6));
          if (usable.length === 0) {
            callback(new Error(`E_RESOLVED_FORBIDDEN: no validated address for family ${family}`), null);
            return;
          }
          if (options?.all) {
            callback(
              null,
              usable.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
            );
            return;
          }
          const first = usable[0];
          callback(null, first, first.includes(':') ? 6 : 4);
        },
        (err) => callback(err, null)
      );
    },
  },
});

// ── Retry + provider policy helpers ─────────────────────────────────────────

/** Applies the server-side provider policy for [host]; policy always wins. */
function applyProviderPolicy(url, headers) {
  const policy = providerHeadersFor(url.hostname);
  if (policy === null) {
    return;
  }
  for (const [name, value] of Object.entries(policy)) {
    headers[name] = value;
  }
}

function isRetryableError(err) {
  if (err instanceof UpstreamError) {
    return err.code === 'E_TIMEOUT' || err.code === 'E_UNREACHABLE';
  }
  // Raw network failures (connection reset, refused, DNS outage, TLS) from
  // the fetch layer are transient by nature.
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * One full attempt: redirect-following GET ending at a final response.
 * Every hop re-checks the URL (host allowlist) and its DNS resolution
 * (post-DNS validation), and applies the server-side provider policy for
 * that hop's host. Retryable HTTP statuses are reported via [retryable] so
 * the caller can decide whether to retry with backoff.
 */
async function attemptOnce({ url, headers, timeoutMs, maxRedirects, maxBytes, signal }) {
  let current = validateUpstreamUrl(url);
  let response = null;
  let redirects = 0;
  const visited = new Set([current.href]);

  while (true) {
    await assertResolvedAllowed(current.hostname);
    const hopHeaders = { ...headers };
    applyProviderPolicy(current, hopHeaders);
    response = await fetch(current, {
      method: 'GET',
      headers: hopHeaders,
      redirect: 'manual',
      signal,
      dispatcher: pinnedDispatcher,
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

    const next = resolveRedirectTarget(location, current);
    if (visited.has(next.href)) {
      throw new UpstreamError('E_REDIRECT_LOOP', 502, 'Upstream redirect loop detected');
    }
    visited.add(next.href);
    current = next;
    redirects += 1;
  }

  return { response, url: current, retryable: RETRYABLE_STATUSES.has(response.status) };
}

export async function fetchUpstream(req, res, sourceUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? UPSTREAM_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? Infinity;
  const maxRetries = options.maxRetries ?? UPSTREAM_RETRY_MAX_ATTEMPTS;

  // Static, honest request headers. The relay identifies itself; it never
  // fabricates Referer/Origin/Cookie/Authorization headers to evade upstream
  // anti-bot controls. Playback headers may only arrive via [options.headers],
  // which the relay route layer restricts to the Referer/Origin declared by
  // the source-resolution flow (the page that embeds the media) — and a
  // CAPTCHA or anti-bot wall is still treated as an unavailable source, not
  // as a condition to bypass. Per-host provider policy (spec §6), when
  // configured server-side, overrides these at each hop.
  const headers = {
    ...(options.headers ?? {}),
    'Accept': '*/*',
    'User-Agent': UPSTREAM_USER_AGENT,
  };

  let controller = new AbortController();
  let disconnected = false;

  const abortCurrent = () => {
    controller.abort();
  };

  const cleanup = bindClientDisconnect(req, res, controller, () => {
    disconnected = true;
    abortCurrent();
  });

  let timer = null;
  const armTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        abortCurrent();
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  };

  try {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) {
        if (disconnected) {
          throw new UpstreamError('E_CLIENT_DISCONNECT', 499, 'Client disconnected');
        }
        const delay = Math.min(
          UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          UPSTREAM_RETRY_MAX_DELAY_MS
        );
        await sleep(delay);
        if (disconnected) {
          throw new UpstreamError('E_CLIENT_DISCONNECT', 499, 'Client disconnected');
        }
      }

      armTimer();
      try {
        const { response, url: finalUrl, retryable } = await attemptOnce({
          url: sourceUrl,
          headers,
          timeoutMs,
          maxRedirects,
          maxBytes,
          signal: controller.signal,
        });

        if (retryable && attempt < maxRetries && !disconnected) {
          await response.body?.cancel();
          continue;
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

        return { response, stream, url: finalUrl };
      } catch (err) {
        if (err instanceof UpstreamError) {
          if (err.code === 'E_UNAUTHORIZED_HOST' || err.code === 'E_CLIENT_DISCONNECT') {
            throw err;
          }
        }
        if (attempt < maxRetries && !disconnected && isRetryableError(err)) {
          // Fresh controller + timer for the next attempt; a stale abort
          // signal must not cancel the retry.
          controller = new AbortController();
          continue;
        }
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
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    }
  } finally {
    cleanup();
    if (timer) {
      clearTimeout(timer);
    }
  }
}