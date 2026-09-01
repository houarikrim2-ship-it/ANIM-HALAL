/**
 * YonaPlay embed extractor (yonaplay.net/embed.php?id={id}).
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'yonaplay';

/** The player API answers with JSON (or occasionally inline-script HTML). */
export const accept = 'application/json, text/plain, */*';
export const allowedContentTypes = ['text/html', 'application/json', 'text/plain'];

/** Fixed framework key the WitAnime theme appends (same as the Android app). */
export const YONAPLAY_API_KEY = '9933bd27-92ea-4ee9-807d-e612029d6318';

const HOST_PATTERNS = [
  /(?:^|[/.])yonaplay\.net(?::\d+)?(?:\/|$)/i,
];

/** True when [url] points at a YonaPlay embed page. */
export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

export function resolve(embedUrl, context = {}) {
  return resolveAll(
    { id, matches, extractStreams, enrichUrl: withApiKey, accept, allowedContentTypes },
    embedUrl,
    context
  );
}

/** Appends the framework API key to yonaplay embed URLs that lack one. */
export function withApiKey(url) {
  if (typeof url !== 'string' || !url.includes('.php')) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('apiKey')) {
      parsed.searchParams.set('apiKey', YONAPLAY_API_KEY);
      return parsed.toString();
    }
  } catch {
    // invalid URL
  }
  return url;
}

export const enrichUrl = withApiKey;

export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  return extractCandidates(html, { pageUrl: baseUrl });
}
