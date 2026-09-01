/**
 * StreamWish embed extractor (streamwish.com / streamwish.to and mirrors).
 */
import { extractCandidates } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'streamwish';

const HOST_PATTERNS = [
  /(?:^|[/.])streamwish\.(?:com|to|pro|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])hlswish\.(?:com|to|pro|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])playerwish\.(?:com|to|pro|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])wishembed\.(?:com|to|pro|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])wishplayer\.(?:com|to|pro|net)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])streamy\.(?:to|pro)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])stish\.(?:to|pro|com)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])embedwish\.(?:com|to)(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])share4max\.com(?::\d+)?(?:\/|$)/i,
  /(?:^|[/.])playmogo\.com(?::\d+)?(?:\/|$)/i,
];

/** True when [url] points at a StreamWish embed page. */
export function matches(url) {
  return HOST_PATTERNS.some((pattern) => pattern.test(url));
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = extractCandidates(html, { pageUrl: baseUrl });

  // StreamWish often uses b n={"15":"...", ...} or similar dictionary shapes
  // which extractCandidates might not catch if they don't look like standard arrays.
  const nMatch = /b\s+n\s*=\s*\{([^}]+)\}/.exec(html);
  if (nMatch) {
      const dict = nMatch[1];
      const urlRe = /"(https?:\/\/[^"]+\.(?:m3u8|mp4|webm|m4v)(?:[?#][^"]*)?)"/gi;
      let urlMatch;
      while ((urlMatch = urlRe.exec(dict)) !== null) {
          if (!out.some(o => o.url === urlMatch[1])) {
              out.push({ url: urlMatch[1], label: null, quality: 'auto' });
          }
      }
  }

  console.log(`[extractor:streamwish] extracted ${out.length} candidates from ${baseUrl}`);
  return out;
}
