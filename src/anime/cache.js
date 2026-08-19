/**
 * Bounded TTL cache for provider metadata.
 *
 * Only metadata is cached (search results, info, episode lists). Stream
 * sources are NEVER cached because media URLs are frequently signed and
 * expire. A zero TTL disables caching for a namespace entirely.
 */
export class TtlCache {
  constructor({ maxEntries = 500, defaultTtlMs = 60_000 } = {}) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (ttlMs <= 0) {
      return;
    }
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}

/** Shared metadata cache for the anime resolver. */
export const metadataCache = new TtlCache({
  maxEntries: Number(process.env.ANIME_CACHE_MAX_ENTRIES ?? 500),
  defaultTtlMs: 60_000,
});