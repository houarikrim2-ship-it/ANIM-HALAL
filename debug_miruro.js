import * as miruro from './src/anime/providers/miruroProvider.js';

async function test() {
    console.log("Testing miruro.catalog...");
    try {
        const rows = await miruro.catalog('trending');
        console.log("Miruro Trending count:", rows.length);
    } catch (e) {
        console.error("Miruro FAILED:", e.message);
    }
}

test();
