/**
 * Generic embed extractor for simple player pages.
 */
import { normalizeUrl, isDirectMediaUrl } from '../anime/normalize.js';
import { extractCandidates, decodeHtmlAttribute } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'generic';

const HOST_PATTERNS = [
  /(?:^|[/.])hglink\.to(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])hgcloud\.to(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])highload\.to(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])highload\.it(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])highload\.link(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])doodstream\.com(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])dood\.(?:to|watch|so|la|sh|re|wf)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])streame.io(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])vidguard\.to(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])vudeo\.(?:net|to)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])videa\.hu(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])yourupload\.com(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])dailymotion\.com(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])mp4upload\.com(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])ok\.ru(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])odnoklassniki\.ru(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])app\.videas\.fr(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])voe\.sx(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])uqload\.(?:io|is|com|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])share4max\.com(?::\d+)?(?:\/|$)/i,
];

export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = extractCandidates(html, { pageUrl: baseUrl });

  // Special case: OK.ru specific (metadata parsing)
  if (baseUrl?.includes('ok.ru') || baseUrl?.includes('odnoklassniki.ru')) {
      const okMatch = /data-options="([^"]+)"/i.exec(html);
      if (okMatch) {
          try {
              const rawOptions = decodeHtmlAttribute(okMatch[1]);
              const options = JSON.parse(rawOptions);
              const metadata = JSON.parse(options.flashvars.metadata);
              if (metadata?.videos) {
                  metadata.videos.forEach(v => {
                      if (v.url) {
                          const url = normalizeUrl(v.url, baseUrl);
                          if (url && !out.some(o => o.url === url)) {
                              out.push({ url, label: v.name, quality: 'auto' });
                          }
                      }
                  });
              }
          } catch (e) {
              // extractCandidates already handles general regex fallback
          }
      }
  }

  return out;
}
