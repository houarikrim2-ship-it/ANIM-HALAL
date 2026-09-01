import { extractSources } from './src/anime/resolver.js';

async function run() {
    try {
        const result = await extractSources({
            anilistId: "101280",
            title: "That Time I Got Reincarnated as a Slime Season 2 Part 2",
            episodeNumber: 1,
            category: "sub"
        });
        console.log("SUCCESS:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("FAILURE:", err);
        if (err.stack) console.error(err.stack);
    }
}

run();
