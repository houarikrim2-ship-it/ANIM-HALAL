import { fetchJson } from './src/anime/http.js';

async function test() {
    console.log("Testing fetchJson...");
    try {
        const { status, json } = await fetchJson("https://api.jikan.moe/v4", "/anime/20");
        console.log("SUCCESS:", status);
    } catch (e) {
        console.error("FAILED:", e.message);
        if (e.cause) console.error("CAUSE:", e.cause);
    }
}

test();
