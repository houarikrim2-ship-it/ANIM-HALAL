import { extractSources } from './src/anime/resolver.js';
import * as scraperRegistry from './src/anime/providers/scraperRegistry.js';
import * as miruro from './src/anime/providers/miruroProvider.js';

// We need to bypass the background task and network
process.env.ANIME_CATALOG_REFRESH_INTERVAL_MS = "0";

async function test() {
    console.log("Testing extractSources for sync issues...");
    try {
        await extractSources({
            anilistId: "20",
            title: "Naruto",
            episodeNumber: 1
        });
    } catch (e) {
        console.log("RESULT:", e.message);
    }
}

test();
