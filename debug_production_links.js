import { fetchHtml } from './src/anime/providers/scraperSupport.js';
import { normalizeUrl, decodeHtmlAttribute, stripTags } from './src/anime/providers/witanimeScraper.js';

function extractResultLinks(html, baseUrl) {
  const out = [];
  const anchorRe = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const attrs = match[1];
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const rawHref = (hrefMatch[1] ?? hrefMatch[2] ?? '').replace(/&amp;/g, '&');
    if (!/\/anime\/|\/episode\//.test(rawHref)) continue;
    const url = normalizeUrl(rawHref, baseUrl);
    if (url === null) continue;

    console.log(`Found link: ${url}`);

    // Simplifed title extraction for debug
    const imgMatch = /<img[^>]+alt="([^"]+)"/i.exec(match[2]);
    if (imgMatch) console.log(`  Img Alt: ${imgMatch[1]}`);
  }
}

async function test() {
    const url = "https://witanime.you/?s=Naruto&search_param=animes";
    console.log(`Fetching ${url}...`);
    try {
        const { text, finalUrl } = await fetchHtml(url, { timeoutMs: 10000 });
        console.log(`Final URL: ${finalUrl}`);
        extractResultLinks(text, finalUrl);
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
