/**
 * Shared embed-resolution implementation for the multi-server extractor
 * layer.
 */
import { ANIME_EXTRACTOR_TIMEOUT_MS } from '../anime/config.js';
import { normalizeStreamSource } from '../anime/normalize.js';
import { fetchHtml, isSafePublicUrl, validateMedia } from '../anime/providers/scraperSupport.js';

/**
 * Resolves one embed page into normalized StreamSource objects.
 */
export async function resolveWithExtractor(extractor, embedUrl, options = {}) {
  if ((process.env.ANIME_EMBED_FOLLOW_ENABLED ?? 'true') === 'false') {
    return { sources: [], error: 'Disabled', extractionStatus: 'FAILED' };
  }
  const timeoutMs = options.timeoutMs ?? ANIME_EXTRACTOR_TIMEOUT_MS;
  const sourceKind = options.sourceKind ?? 'WATCH';

  let fetchResult;
  try {
    const accept = extractor.accept ?? null;
    const allowedContentTypes = extractor.allowedContentTypes ?? ['text/html', 'application/xhtml', 'application/json'];
    const requestUrl =
      typeof extractor.enrichUrl === 'function' ? extractor.enrichUrl(embedUrl) : embedUrl;

    console.log(`[Resolver] PROVIDER_ATTEMPT provider=${extractor.id} url=${requestUrl}`);
    fetchResult = await fetchHtml(requestUrl, {
      provider: `embed:${extractor.id}`,
      timeoutMs,
      accept,
      allowedContentTypes,
    });
    console.log(`[Resolver] PROVIDER_HTTP_RESULT provider=${extractor.id} status=${fetchResult.status}`);
  } catch (err) {
    console.warn(`[Resolver] PROVIDER_HTTP_FAILED provider=${extractor.id} error=${err?.message ?? 'unknown'}`);
    return {
      sources: [],
      error: err.message,
      status: err.status,
      extractionStatus: 'FAILED'
    };
  }

  const { text, finalUrl } = fetchResult;
  try {
    const candidates = await extractor.extractStreams(text, { pageUrl: finalUrl });
    console.log(`[Resolver] PROVIDER_EXTRACTED provider=${extractor.id} candidates=${candidates.length}`);
    const sources = [];

    const typeFromUrl = (rawUrl) =>
      /\.m3u8([?#]|$)/i.test(rawUrl) ? 'hls' : 'mp4';

    // Conclusive negatives that always drop a candidate. PROBE_UNAVAILABLE
    // (no response at all) carries no information and is intentionally absent:
    // the candidate is kept with a URL-shape-derived type instead.
    const CONCLUDED_REJECT = new Set([
      'UNSAFE',
      'NOT_FOUND',
      'HTTP_ERROR',
      'UNSUPPORTED_TYPE',
      'INVALID_HLS_MANIFEST',
    ]);

    for (const candidate of candidates) {
      if (!isSafePublicUrl(candidate.url)) {
        console.log(`[Resolver] SOURCE_REJECTED provider=${extractor.id} url=${candidate.url} reason=UNSAFE`);
        continue;
      }

      const validation = await validateMedia(candidate.url, {
          headers: { referer: finalUrl },
          timeoutMs: 8000
      });

      let url = candidate.url;
      let type = null;
      if (validation.valid) {
        url = validation.finalUrl || candidate.url;
        type = validation.type;
        console.log(`[Resolver] SOURCE_CLASSIFIED provider=${extractor.id} finalType=DIRECT_MEDIA playable=true reason=EXTRACTOR_SUCCESS contentType=${validation.contentType}`);
      } else if (CONCLUDED_REJECT.has(validation.reason)) {
        console.log(`[Resolver] SOURCE_CLASSIFIED provider=${extractor.id} finalType=DEAD playable=false reason=${validation.reason} detail=${validation.detail ?? ''}`);
        continue;
      } else {
        // PROBE_UNAVAILABLE: no conclusive information -> keep a best-effort
        // source so a flaky/misbehaving host can never nuke a real candidate.
        type = typeFromUrl(candidate.url);
        console.log(`[Resolver] SOURCE_CLASSIFIED provider=${extractor.id} finalType=DIRECT_MEDIA playable=true reason=PROBE_UNAVAILABLE_TRUST_SHAPE type=${type}`);
      }

      const normalized = normalizeStreamSource(
        {
          url,
          referer: finalUrl,
          origin: new URL(finalUrl).origin,
          label: candidate.label ?? null,
          quality: candidate.quality ?? null,
          type,
        },
        { providerName: extractor.id, language: 'sub', baseUrl: finalUrl, sourceKind },
      );

      if (normalized !== null) {
        sources.push({
          ...normalized,
          extractionStatus: 'DIRECT'
        });
        console.log(`[Resolver] PROVIDER_DIRECT_VALIDATED provider=${extractor.id} url=${url} type=${normalized.type} quality=${normalized.quality}`);
      }
    }

    if (sources.length > 0) {
      console.log(`[Resolver] EXTRACTOR_RESULT provider=${extractor.id} direct=${sources.length} embed=0`);
      return { sources, error: null, extractionStatus: 'DIRECT' };
    } else {
      console.log(`[Resolver] EXTRACTOR_RESULT provider=${extractor.id} direct=0 embed=1`);
      return { sources: [], error: null, extractionStatus: 'EMBED' };
    }
  } catch (err) {
    console.warn(`[Resolver] EXTRACTOR_CRASH provider=${extractor.id} error=${err.message}`);
    return { sources: [], error: err.message, extractionStatus: 'FAILED' };
  }
}

/**
 * Returns all verified sources found by the extractor.
 */
export async function resolveAll(extractor, embedUrl, context = {}) {
  const result = await resolveWithExtractor(extractor, embedUrl, {
    timeoutMs: context.timeoutMs,
    pageUrl: context.pageUrl,
    sourceKind: context.sourceKind
  });

  if (result.extractionStatus === 'DIRECT') {
      return result.sources.map(s => ({
          name: s.name,
          quality: s.quality,
          url: s.url,
          type: s.type,
          headers: s.headers ?? null,
          extractionStatus: 'DIRECT',
          sourceKind: s.sourceKind,
          isEmbed: false
      }));
  }

  if (result.extractionStatus === 'EMBED') {
     return [{
        name: extractor.id,
        quality: 'auto',
        url: embedUrl,
        type: 'embed',
        headers: null,
        extractionStatus: 'EMBED',
        sourceKind: context.sourceKind ?? 'WATCH',
        isEmbed: true
     }];
  }

  return [];
}
