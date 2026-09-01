/**
 * Google Drive embed extractor.
 * Proxies through gdriveplayer.to for native extraction.
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'gdrive';

export function matches(url) {
  return /(?:^|[/.])drive\.google\.com(?::\d+)?(?:\/|$)/i.test(url);
}

export function enrichUrl(url) {
    return `https://gdriveplayer.to/embed2.php?link=${encodeURIComponent(url)}`;
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, enrichUrl, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  return extractCandidates(html, { pageUrl: context.pageUrl });
}
