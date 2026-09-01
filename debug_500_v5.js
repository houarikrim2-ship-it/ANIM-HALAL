import { extractSources } from './src/anime/resolver.js';

// Mock fetch to return 500
global.fetch = async (url) => {
    console.log(`[MOCK FETCH] ${url}`);
    return {
        status: 500,
        ok: false,
        headers: new Map(),
        body: { cancel: async () => {} },
        text: async () => "Internal Error",
        json: async () => ({ error: "Internal Error" })
    };
};

async function run() {
    try {
        console.log("Starting mocked extraction (500)...");
        await extractSources({
            anilistId: "101280",
            title: "Slime",
            episodeNumber: 1
        });
    } catch (err) {
        console.log("CAUGHT ERROR:", err.constructor.name);
        console.log("Message:", err.message);
        console.log("Code:", err.code);
        if (err.stack) console.log("Stack:", err.stack);
    }
}

run();
