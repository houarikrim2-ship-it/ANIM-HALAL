import * as witanime from './src/anime/providers/witanimeScraper.js';
import * as anime4up from './src/anime/providers/anime4upScraper.js';

async function test() {
    const title = "Naruto";
    console.log("Testing WITAnime search...");
    try {
        const url = await witanime.searchAnimePage(title);
        console.log("WITAnime URL:", url);
    } catch (e) {
        console.error("WITAnime FAILED:", e);
    }

    console.log("Testing Anime4Up search...");
    try {
        const url = await anime4up.searchAnimePage(title);
        console.log("Anime4Up URL:", url);
    } catch (e) {
        console.error("Anime4Up FAILED:", e);
    }
}

test();
