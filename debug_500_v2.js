import { extractSources } from './src/anime/resolver.js';

async function run() {
    try {
        console.log("Starting extraction...");
        const result = await extractSources({
            anilistId: "101280",
            title: "That Time I Got Reincarnated as a Slime Season 2 Part 2",
            episodeNumber: 1,
            category: "sub"
        });
        console.log("SUCCESS:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("FAILURE TYPE:", err.constructor.name);
        console.error("FAILURE MESSAGE:", err.message);
        if (err.stack) console.error("STACK:", err.stack);
        if (err.cause) console.error("CAUSE:", err.cause);
    }
}

run();
