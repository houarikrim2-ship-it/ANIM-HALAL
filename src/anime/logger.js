/**
 * Structured provider diagnostics.
 *
 * Logged fields are deliberately restricted to provider identity, request
 * type, opaque identifiers, HTTP status, latency and failure category.
 * Never logged: API secrets, tokens, cookies, complete signed URLs or user
 * credentials.
 */

function safeField(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return value;
}

export function logProviderEvent(fields) {
  const record = {
    t: new Date().toISOString(),
    event: 'anime.provider',
    provider: safeField(fields.provider),
    requestType: safeField(fields.requestType),
    animeId: safeField(fields.animeId),
    episodeId: safeField(fields.episodeId),
    status: fields.status,
    latencyMs: fields.latencyMs,
    failureCategory: safeField(fields.failureCategory),
    fallbackProvider: safeField(fields.fallbackProvider),
    attemptedProviders: fields.attemptedProviders,
  };
  const line = JSON.stringify(record);
  if (fields.failureCategory) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Short-lived diagnostics for a single resolution attempt. */
export class ProviderAttempt {
  constructor(provider) {
    this.provider = provider;
    this.requestType = null;
    this.animeId = null;
    this.episodeId = null;
    this.startedAt = Date.now();
    this.status = null;
    this.failureCategory = null;
  }

  finish(fields = {}) {
    this.status = fields.status ?? this.status;
    this.failureCategory = fields.failureCategory ?? this.failureCategory;
    logProviderEvent({
      provider: this.provider,
      requestType: fields.requestType ?? this.requestType,
      animeId: fields.animeId ?? this.animeId,
      episodeId: fields.episodeId ?? this.episodeId,
      status: this.status,
      latencyMs: Date.now() - this.startedAt,
      failureCategory: this.failureCategory,
      fallbackProvider: fields.fallbackProvider,
      attemptedProviders: fields.attemptedProviders,
    });
  }
}