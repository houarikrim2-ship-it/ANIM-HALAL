import { fetchHtml } from './src/anime/providers/scraperSupport.js';
import { decodeEpisodeGrid } from './src/anime/providers/witanimeScraper.js';

async function test() {
    const url = "https://witanime.you/anime/naruto/";
    console.log(`Fetching ${url}...`);
    try {
        const { text } = await fetchHtml(url, { timeoutMs: 10000 });
        const episodes = decodeEpisodeGrid(text);
        console.log(`Episodes Found: ${episodes.length}`);
        if (episodes.length > 0) {
            console.log(`Sample: EP ${episodes[0].number} -> ${episodes[0].url}`);
        } else {
            console.log("No processedEpisodeData found. Checking for challenge markers...");
            if (text.includes("processedEpisodeData")) {
                console.log("MARKER FOUND but decode failed");
            } else {
                console.log("MARKER NOT FOUND");
            }
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
