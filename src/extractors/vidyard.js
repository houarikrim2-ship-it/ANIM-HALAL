/**
 * VidYard embed extractor.
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'vidyard';

export function matches(url) {
  return /(?:^|[/.])vidyard\.com(?::\d+)?(?:\/|$)/i.test(url);
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  return extractCandidates(html, { pageUrl: context.pageUrl });
}
