import { fetch } from 'undici';
import { extractSources } from './src/anime/resolver.js';

global.fetch = fetch;

async function run() {
    try {
        console.log("Starting debug_undici...");
        await extractSources({
            anilistId: "20",
            title: "Naruto",
            episodeNumber: 1
        });
    } catch (e) {
        console.log("CAUGHT:", e.message);
    }
}

run();
