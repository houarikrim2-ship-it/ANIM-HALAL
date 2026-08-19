/**
 * Multi-server embed extractor registry.
 *
 * Scraper providers hand embed URLs (StreamWish / Vidas / YonaPlay player
 * pages) to [resolveEmbed], which:
 *   1. finds the extractor that owns the host,
 *   2. fetches the embed page with bounded timeout + browser headers
 *      (challenge pages are classified and dropped — never bypassed),
 *   3. extracts direct media candidates by regex/JSON parsing,
 *   4. validates every URL (http(s), direct media suffix, no private /
 *      loopback / reserved hosts),
 *   5. normalizes to the stable StreamSource model tagged with the host id
 *      (the Android UI renders this as the server name) and its quality
 *      label.
 *
 * Failure contract: one broken embed host NEVER breaks the request. Every
 * error is caught and logged; the server is simply omitted from the list.
 */
import { ANIME_EXTRACTOR_TIMEOUT_MS } from '../anime/config.js';
import { normalizeStreamSource } from '../anime/normalize.js';
import { fetchHtml, isSafePublicUrl } from '../anime/providers/scraperSupport.js';
import * as streamwish from './streamwish.js';
import * as vidas from './vidas.js';
import * as yonaplay from './yonaplay.js';

/** Ordered extractor list; first match wins. */
export const EXTRACTORS = [streamwish, vidas, yonaplay];

/** Returns the extractor module owning [url], or null. */
export function extractorFor(url) {
  return EXTRACTORS.find((extractor) => extractor.matches(url)) ?? null;
}

/**
 * Resolves one embed page into normalized StreamSource objects.
 *
 * @param {string} embedUrl
 * @param {object} options
 *   timeoutMs   per-request timeout (default ANIME_EXTRACTOR_TIMEOUT_MS)
 *   extractors  injectable extractor list (tests)
 * @returns {Promise<Array>} normalized sources; empty when the host is
 *   unknown, unreachable, challenged, malformed or disabled.
 */
export async function resolveEmbed(embedUrl, options = {}) {
  // Read lazily (not at module load) so tests and runtime toggles work.
  if ((process.env.ANIME_EMBED_FOLLOW_ENABLED ?? 'true') === 'false') {
    return [];
  }
  const extractors = options.extractors ?? EXTRACTORS;
  const extractor = extractors.find((candidate) => candidate.matches(embedUrl));
  if (!extractor) {
    return [];
  }
  const timeoutMs = options.timeoutMs ?? ANIME_EXTRACTOR_TIMEOUT_MS;
  try {
    const accept = extractor.accept ?? null;
    const allowedContentTypes = extractor.allowedContentTypes ?? ['text/html', 'application/xhtml'];
    const { text, finalUrl } = await fetchHtml(embedUrl, {
      provider: `embed:${extractor.id}`,
      timeoutMs,
      accept,
      allowedContentTypes,
    });
    const candidates = extractor.extractStreams(text, { pageUrl: finalUrl });
    const sources = [];
    for (const candidate of candidates) {
      if (!isSafePublicUrl(candidate.url)) {
        continue;
      }
      const normalized = normalizeStreamSource(
        {
          url: candidate.url,
          referer: finalUrl,
          origin: new URL(finalUrl).origin,
          label: candidate.label ?? null,
          quality: candidate.quality ?? null,
        },
        { providerName: extractor.id, language: 'sub', baseUrl: finalUrl },
      );
      if (normalized !== null) {
        sources.push(normalized);
      }
    }
    return sources;
  } catch (err) {
    console.warn(
      `[extractor] ${extractor.id} skipped for ${embedUrl}: ${err?.message ?? 'unknown error'}`
    );
    return [];
  }
}