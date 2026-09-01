/**
 * OK.ru (Odnoklassniki) embed extractor.
 */
import { normalizeUrl } from '../anime/normalize.js';
import { decodeHtmlAttribute } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'okru';

export function matches(url) {
  return /(?:^|[/.])ok\.ru(?::\d+)?(?:\/|$)/i.test(url) ||
         /(?:^|[/.])odnoklassniki\.ru(?::\d+)?(?:\/|$)/i.test(url);
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = [];

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
            if (url) {
              out.push({ url, label: v.name || 'auto', quality: v.name || 'auto' });
            }
          }
        });
      }
    } catch (e) {
      // fallback to generic extraction logic if JSON fails
    }
  }

  return out;
}
