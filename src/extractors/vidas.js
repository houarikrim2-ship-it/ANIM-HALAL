/**
 * Vidas embed extractor (vidas.su / vida.su mirrors).
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'vidas';

const HOST_PATTERNS = [
  /(?:^|[/.])vidas\.su(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])vida\.su(?::\d+)?(?:\/|$)/i,
];

/** True when [url] points at a Vidas embed page. */
export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  return extractCandidates(html, { pageUrl: baseUrl });
}
