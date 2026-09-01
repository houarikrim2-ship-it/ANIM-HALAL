import { fetchHtml } from './src/anime/providers/scraperSupport.js';
import { extractCandidates } from './src/anime/providers/scraperSupport.js';

async function test() {
    const url = "https://playerwish.com/e/uynnctb0nuwx";
    console.log(`Fetching ${url}...`);
    try {
        const { text, finalUrl } = await fetchHtml(url, { timeoutMs: 10000 });
        console.log(`Final URL: ${finalUrl}`);

        if (text.includes("Just a moment")) {
            console.log("DETECTED CLOUDFLARE CHALLENGE");
            return;
        }

        const candidates = extractCandidates(text, { pageUrl: finalUrl });
        console.log(`Candidates Found: ${candidates.length}`);
        candidates.forEach(c => console.log(`- ${c.url}`));

        if (candidates.length === 0) {
            console.log("No candidates found. Searching for 'file:' or 'src:' in HTML...");
            const fileMatch = /file\s*:\s*"([^"]+)"/.exec(text);
            if (fileMatch) console.log(`Found raw file: ${fileMatch[1]}`);
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
