import { fetchJson } from './src/anime/http.js';
import { ANIME_API_BASE_URL } from './src/anime/config.js';

async function test() {
    const id = "101280";
    console.log(`Testing Miruro info for ${id}...`);
    try {
        const { status, json } = await fetchJson(ANIME_API_BASE_URL, `/api/info/${id}`, { timeoutMs: 10000 });
        console.log(`Status: ${status}`);
        console.log(`JSON:`, JSON.stringify(json, null, 2));
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
        if (e.status) console.log(`Status: ${e.status}`);
    }
}

test();
