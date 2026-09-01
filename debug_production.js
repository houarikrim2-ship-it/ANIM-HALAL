import { extractSources } from './src/anime/resolver.js';

async function run() {
    console.log("Running production-like extraction...");
    try {
        const result = await extractSources({
            anilistId: "101280",
            title: "That Time I Got Reincarnated as a Slime Season 2 Part 2",
            episodeNumber: 1
        });
        console.log("SUCCESS:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.log("FAILED:", err.code, err.message);
    }
}

run();
