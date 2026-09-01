import { extractSources } from './src/anime/resolver.js';
import * as scraperRegistry from './src/anime/providers/scraperRegistry.js';

// We need to use a proxy or something to mock the imported module
// But for now, let's just check if there's any obvious issue in resolver.js

async function test() {
    console.log("Testing extractSources with missing title...");
    try {
        await extractSources({ anilistId: "20", episodeNumber: 1 });
    } catch (e) {
        console.log("EXPECTED ERROR:", e.code, e.message);
    }

    console.log("Testing extractSources with empty providedTitle...");
    try {
        await extractSources({ anilistId: "20", title: "", episodeNumber: 1 });
    } catch (e) {
        console.log("EXPECTED ERROR:", e.code, e.message);
    }
}

test();
