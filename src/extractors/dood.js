/**
 * DoodStream embed extractor.
 */
import { extractCandidates, fetchHtml } from '../anime/providers/scraperSupport.js';
import { resolveAll } from './resolver.js';

export const id = 'dood';

export function matches(url) {
  return /(do*d(?:stream)?\.(?:com?|watch|to|s[ho]|cx|la|w[sf]|pm|re|yt|stream))\/[de]\/([0-9a-zA-Z]+)/i.test(url);
}

export function resolve(embedUrl, context = {}) {
  return resolveAll({ id, matches, extractStreams }, embedUrl, context);
}

export async function extractStreams(html, context = {}) {
  const baseUrl = context.pageUrl ?? null;
  const out = [];

  // DoodStream logic often requires following /pass_md5/
  const md5Match = /\$.get\('\/pass_md5\/([^']+)'/.exec(html);
  if (md5Match) {
      try {
          const passUrl = new URL(baseUrl).origin + `/pass_md5/${md5Match[1]}`;
          const { text: passContent } = await fetchHtml(passUrl, { referer: baseUrl });

          const token = md5Match[1];
          const expiry = Date.now();
          const finalUrl = `${passContent}1234567890?token=${token}&expiry=${expiry}`;

          out.push({ url: finalUrl, label: 'DoodStream', quality: 'auto' });
      } catch (e) {
          console.warn(`[extractor:dood] failed to resolve pass_md5: ${e.message}`);
      }
  }

  // Fallback to candidates
  const candidates = extractCandidates(html, { pageUrl: baseUrl });
  candidates.forEach(c => {
      if (!out.some(o => o.url === c.url)) out.push(c);
  });

  return out;
}
