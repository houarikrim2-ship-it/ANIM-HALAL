import { fetchHtml } from './src/anime/providers/scraperSupport.js';

function extractResultLinks(html, baseUrl) {
  const anchorRe = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const attrs = match[1];
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const url = hrefMatch[1] ?? hrefMatch[2];
    if (!/\/anime\/|\/episode\//.test(url)) continue;

    console.log(`Found link: ${url}`);

    const imgMatch = /<img[^>]+alt="([^"]+)"/i.exec(match[2]);
    if (imgMatch) console.log(`  Img Alt: ${imgMatch[1]}`);

    const titleMatch = /title="([^"]+)"/i.exec(attrs);
    if (titleMatch) console.log(`  Anchor Title: ${titleMatch[1]}`);
  }
}

async function test() {
    const url = "https://witanime.you/?s=Naruto&search_param=animes";
    console.log(`Fetching ${url}...`);
    try {
        const { text, finalUrl } = await fetchHtml(url, { timeoutMs: 10000 });
        console.log(`Final URL: ${finalUrl}`);
        if (text.includes("Just a moment")) {
            console.log("DETECTED CLOUDFLARE CHALLENGE");
        }
        extractResultLinks(text, finalUrl);
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
