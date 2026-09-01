import { extractSources } from './src/anime/resolver.js';
import { AnimeApiError } from './src/anime/errors.js';

// Mock fetch to return 404 for everything
global.fetch = async (url) => {
    console.log(`[MOCK FETCH] ${url}`);
    return {
        status: 404,
        ok: false,
        headers: new Map(),
        body: { cancel: async () => {} },
        text: async () => "Not Found",
        json: async () => ({ error: "Not Found" })
    };
};

async function run() {
    try {
        console.log("Starting mocked extraction...");
        const result = await extractSources({
            anilistId: "101280",
            title: "Slime",
            episodeNumber: 1,
            category: "sub"
        });
        console.log("SUCCESS:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.log("CAUGHT ERROR");
        console.log("instanceof AnimeApiError:", err instanceof AnimeApiError);
        console.log("Name:", err.name);
        console.log("Message:", err.message);
        if (err.stack) console.log("Stack:", err.stack);
    }
}

run();
