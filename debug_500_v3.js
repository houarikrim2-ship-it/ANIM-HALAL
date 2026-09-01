import { extractSources } from './src/anime/resolver.js';
import * as scraperRegistry from './src/anime/providers/scraperRegistry.js';

async function test() {
    console.log("Starting debug_500_v3...");

    // We can't mock imports easily, so we use a different approach.
    // If the 500 is a crash, we want to see where.

    try {
        await extractSources({
            anilistId: "20",
            title: "Naruto",
            episodeNumber: 1
        });
    } catch (e) {
        console.log("CAUGHT ERROR:", e.constructor.name);
        console.log("Message:", e.message);
        console.log("Stack:", e.stack);
    }
}

test();
