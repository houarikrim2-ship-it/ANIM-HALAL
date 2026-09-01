/**
 * Mp4Upload embed extractor.
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'mp4upload';

export function matches(url) {
  return /(?:^|[/.])mp4upload\.com(?::\d+)?(?:\/|$)/i.test(url);
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  return extractCandidates(html, { pageUrl: context.pageUrl });
}
