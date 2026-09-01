import * as anime4up from './src/anime/providers/anime4upScraper.js';
import * as witanime from './src/anime/providers/witanimeScraper.js';

async function test() {
    const providers = [
        { id: 'witanime', mod: witanime },
        { id: 'anime4up', mod: anime4up }
    ];

    for (const p of providers) {
        console.log(`Checking ${p.id}...`);
        try {
            console.log(`- NAME: ${p.mod.NAME}`);
            if (typeof p.mod.searchAnimePage !== 'function') console.error(`  ! searchAnimePage missing`);
            if (typeof p.mod.episodePageUrl !== 'function') console.error(`  ! episodePageUrl missing`);
            if (typeof p.mod.resolveEpisodeSources !== 'function') console.error(`  ! resolveEpisodeSources missing`);
        } catch (e) {
            console.error(`  ! FAILED:`, e.message);
        }
    }
}

test();
