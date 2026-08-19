/**
 * Structured error model for the anime source-resolution layer.
 *
 * Codes are stable and machine-readable so clients can react without parsing
 * free-form messages. Raw provider stack traces are never exposed to clients.
 */
export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  ANIME_NOT_FOUND: 'ANIME_NOT_FOUND',
  EPISODE_NOT_FOUND: 'EPISODE_NOT_FOUND',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  STREAM_UNAVAILABLE: 'STREAM_UNAVAILABLE',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_SOURCE',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_BLOCKED: 'UPSTREAM_BLOCKED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** HTTP status used for each error code. */
export const ERROR_HTTP_STATUS = Object.freeze({
  INVALID_REQUEST: 400,
  ANIME_NOT_FOUND: 404,
  EPISODE_NOT_FOUND: 404,
  PROVIDER_UNAVAILABLE: 502,
  STREAM_UNAVAILABLE: 502,
  UNSUPPORTED_SOURCE: 422,
  RATE_LIMITED: 429,
  UPSTREAM_BLOCKED: 502,
  NETWORK_ERROR: 502,
  TIMEOUT: 504,
  INTERNAL_ERROR: 500,
});

export class AnimeApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AnimeApiError';
    this.code = code;
    this.status = options.status ?? ERROR_HTTP_STATUS[code] ?? 500;
    this.provider = options.provider ?? null;
    this.failureCategory = options.failureCategory ?? code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toResponseBody() {
    return { success: false, error: { code: this.code, message: this.message } };
  }
}

/**
 * Maps an arbitrary thrown error (fetch failure, HTTP status, HTML challenge)
 * into a stable [AnimeApiError]. Never leaks raw provider internals to the
 * client: only the code + a short message leave this function.
 */
export function toApiError(cause, context = {}) {
  if (cause instanceof AnimeApiError) {
    return cause;
  }
  const provider = context.provider ?? null;
  const status = cause?.status ?? cause?.response?.status;

  if (status === 404) {
    return new AnimeApiError(ERROR_CODES.ANIME_NOT_FOUND, 'The requested anime was not found', {
      provider,
      cause,
    });
  }
  if (status === 429) {
    return new AnimeApiError(ERROR_CODES.RATE_LIMITED, 'The provider is rate-limiting requests', {
      provider,
      cause,
    });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new AnimeApiError(ERROR_CODES.UPSTREAM_BLOCKED, 'The provider rejected the request', {
      provider,
      cause,
    });
  }
  if (status !== undefined && status >= 500) {
    return new AnimeApiError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'The provider is unavailable', {
      provider,
      cause,
    });
  }
  if (cause?.name === 'TimeoutError' || cause?.code === 'ETIMEDOUT' || cause?.isTimeout) {
    return new AnimeApiError(ERROR_CODES.TIMEOUT, 'The provider did not respond in time', {
      provider,
      cause,
    });
  }
  return new AnimeApiError(ERROR_CODES.NETWORK_ERROR, 'The provider could not be reached', {
    provider,
    cause,
  });
}

/** True when a response looks like a CAPTCHA / anti-bot challenge page. */
export function isChallengeResponse(response) {
  const contentType = response?.headers?.get?.('content-type') ?? '';
  if (/text\/html/i.test(contentType)) {
    return true;
  }
  const headers = response?.headers;
  if (headers && (headers.has('cf-challenge') || headers.has('cf-mitigated'))) {
    return true;
  }
  return false;
}