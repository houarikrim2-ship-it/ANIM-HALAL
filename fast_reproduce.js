import { extractSources } from './src/anime/resolver.js';
import * as scraperRegistry from './src/anime/providers/scraperRegistry.js';
import * as miruro from './src/anime/providers/miruroProvider.js';

// Mock scraper registry to return nothing immediately
scraperRegistry.resolveEpisodeSources = async () => {
    console.log("[MOCK] resolveEpisodeSources called");
    return { sources: [], provider: null, failures: [] };
};

// Mock miruro info to avoid network
miruro.info = async () => {
    console.log("[MOCK] miruro.info called");
    return { title: { english: "Slime" } };
};

async function run() {
    try {
        console.log("Starting fast extraction...");
        const result = await extractSources({
            anilistId: "101280",
            title: "Slime",
            episodeNumber: 1,
            category: "sub"
        });
        console.log("SUCCESS:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("FAILURE:", err.message);
        console.error(err.stack);
    }
}

run();
