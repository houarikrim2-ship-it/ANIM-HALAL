/**
 * Provider HTTP client: bounded timeouts + controlled retries.
 *
 * Retry policy:
 * - Retryable: network failures, timeouts, HTTP 429 and temporary 5xx.
 * - NOT retried: 4xx (401/403/404/...), challenge/HTML responses and any
 *   successful response. Retrying those would not solve the problem.
 *
 * The client only talks to the configured provider base URLs (validated at
 * startup in anime/config.js). It never fetches arbitrary client-supplied
 * destinations, so it cannot become an SSRF proxy.
 */
import { ANIME_MAX_ATTEMPTS, ANIME_PROVIDER_TIMEOUT_MS } from './config.js';
import {
  AnimeApiError,
  ERROR_CODES,
  isChallengeResponse,
  toApiError,
} from './errors.js';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ATTEMPT_MS = [0, 300]; // backoff before attempt #2 (and beyond)

function isNetworkFailure(err) {
  return (
    err instanceof TypeError || // fetch-level network failure
    err?.name === 'AbortError' || // timeout aborted the request
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ENOTFOUND' ||
    err?.code === 'EAI_AGAIN'
  );
}

function classify(response) {
  const status = response.status;
  if (isChallengeResponse(response)) {
    return { code: ERROR_CODES.UPSTREAM_BLOCKED, retryable: false };
  }
  if (status === 429) {
    return { code: ERROR_CODES.RATE_LIMITED, retryable: true };
  }
  if (status >= 500) {
    return { code: ERROR_CODES.PROVIDER_UNAVAILABLE, retryable: true };
  }
  if (status === 404) {
    return { code: ERROR_CODES.ANIME_NOT_FOUND, retryable: false };
  }
  if (status >= 400) {
    return { code: ERROR_CODES.UPSTREAM_BLOCKED, retryable: false };
  }
  return { code: null, retryable: false };
}

/**
 * GETs a JSON endpoint under [baseUrl].
 *
 * @param {string} baseUrl  http(s) base URL of the provider
 * @param {string} path     path + query, e.g. "/api/search?query=x"
 * @param {object} options  { timeoutMs, maxAttempts, headers, provider }
 * @returns {Promise<{ status: number, json: any, headers: Headers }>}
 * @throws {AnimeApiError}
 */
export async function fetchJson(baseUrl, path, options = {}) {
  const timeoutMs = options.timeoutMs ?? ANIME_PROVIDER_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? ANIME_MAX_ATTEMPTS);
  const provider = options.provider ?? 'unknown';
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const backoff = RETRYABLE_ATTEMPT_MS[attempt - 1] ?? RETRYABLE_ATTEMPT_MS.at(-1);
    if (backoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'anime-halal-backend/1.0',
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        lastError = new AnimeApiError(ERROR_CODES.TIMEOUT, 'Provider request timed out', {
          provider,
          cause: err,
        });
      } else {
        lastError = toApiError(err, { provider });
      }
      if (isNetworkFailure(err)) {
        continue; // transient: retry
      }
      break;
    } finally {
      clearTimeout(timer);
    }

    const classification = classify(response);
    if (!classification.code && response.ok) {
      let json;
      try {
        json = await response.json();
      } catch (err) {
        throw new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, 'Provider returned a non-JSON response', {
          provider,
          cause: err,
        });
      }
      return { status: response.status, json, headers: response.headers };
    }
    if (classification.retryable && attempt < maxAttempts) {
      lastError = new AnimeApiError(classification.code, `Provider HTTP ${response.status}`, {
        provider,
        status: response.status,
      });
      try { await response.body?.cancel(); } catch { /* ignore */ }
      continue;
    }
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new AnimeApiError(classification.code, `Provider HTTP ${response.status}`, {
      provider,
      status: response.status,
    });
  }

  throw lastError ?? new AnimeApiError(ERROR_CODES.NETWORK_ERROR, 'Provider could not be reached', { provider });
}

/**
 * Wraps a provider call so every failure is normalized into a stable
 * [AnimeApiError] with the provider name attached. Provider internals never
 * escape this helper.
 */
export async function withProviderGuard(providerName, fn, context = {}) {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err, { provider: providerName, ...context });
  }
}