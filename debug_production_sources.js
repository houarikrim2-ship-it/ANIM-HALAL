import { fetchHtml } from './src/anime/providers/scraperSupport.js';
import { collectWatchServers, decodeIframeResources } from './src/anime/providers/witanimeScraper.js';

async function test() {
    const url = "https://witanime.you/episode/naruto-%d8%a7%d9%84%d8%ad%d9%84%d9%82%d8%a9-1/";
    console.log(`Fetching ${url}...`);
    try {
        const { text, finalUrl } = await fetchHtml(url, { timeoutMs: 10000 });
        console.log(`Final URL: ${finalUrl}`);

        const servers = collectWatchServers(text, finalUrl);
        console.log(`Servers Found: ${servers.length}`);
        servers.forEach(s => console.log(`- ${s.name}: ${s.url}`));

        if (servers.length === 0) {
            console.log("No servers found. Checking for _zT / _zV...");
            if (text.includes("_zT")) console.log("_zT marker FOUND");
            if (text.includes("_zV")) console.log("_zV marker FOUND");
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
