/**
 * VidBom embed extractor.
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'vidbom';

export function matches(url) {
  return /(?:^|[/.])(?:vidbom|myvid|segavid|vidshare|vadbom|vidshare)\.(?:com|net|org|xyz|to|pro|net)(?::\d+)?(?:\/|$)/i.test(url);
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  return extractCandidates(html, { pageUrl: context.pageUrl });
}
