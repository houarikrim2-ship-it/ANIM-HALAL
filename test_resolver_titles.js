import { extractSources } from './src/anime/resolver.js';

// We just want to check the logging of titlesToTry
// Since we can't easily mock, we'll just check if it compiles and runs.

async function test() {
    console.log("Testing extractSources title logic...");
    try {
        // This will likely fail but we want to see the titlesToTry in the log
        await extractSources({
            anilistId: "101280",
            title: "Slime",
            slug: "tensei-shitara-slime-datta-ken-2nd-season-part-2-episode-1",
            episodeNumber: 1
        });
    } catch (e) {
        // ignore
    }
}

test();
