import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function testWitanimeDetails() {
    console.log('--- WITANIME DETAILS AUDIT ---');
    const url = "https://witanime.cyou/anime/one-piece/";
    try {
        const { text } = await fetchHtml(url);
        const title = text.match(/<h1[^>]*class="[^"]*anime-details-title[^"]*"[^>]*>(.*?)<\/h1>/i)?.[1]?.trim();
        const story = text.match(/<p[^>]*class="[^"]*anime-story[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]?.trim();
        const cover = text.match(/<img[^>]*class="[^"]*thumbnail[^"]*"[^>]*src="([^"]+)"/i)?.[1];

        console.log(`Title: ${title ? 'OK (' + title + ')' : 'MISSING'}`);
        console.log(`Story: ${story ? 'OK' : 'MISSING'}`);
        console.log(`Cover: ${cover ? 'OK (' + cover + ')' : 'MISSING'}`);

        const genreRe = /<ul\s+class="[^"]*anime-genres[^"]*"[^>]*>([\s\S]*?)<\/ul>/i;
        console.log(`Genres: ${genreRe.test(text) ? 'OK' : 'MISSING'}`);

    } catch (e) {
        console.error(`WITANIME Failed: ${e.message}`);
    }
}

async function testAnime4upDetails() {
    console.log('\n--- ANIME4UP DETAILS AUDIT ---');
    const url = "https://w1.anime4up.rest/anime/one-piece-pyfgh/";
    try {
        const { text } = await fetchHtml(url);
        const title = text.match(/<h1[^>]*class="[^"]*anime-details-title[^"]*"[^>]*>(.*?)<\/h1>/i)?.[1]?.trim();
        const story = text.match(/<p[^>]*class="[^"]*anime-story[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]?.trim();
        const cover = text.match(/<img[^>]*class="[^"]*thumbnail[^"]*"[^>]*src="([^"]+)"/i)?.[1];

        console.log(`Title: ${title ? 'OK (' + title + ')' : 'MISSING'}`);
        console.log(`Story: ${story ? 'OK' : 'MISSING'}`);
        console.log(`Cover: ${cover ? 'OK (' + cover + ')' : 'MISSING'}`);

        const genreRe = /<ul\s+class="[^"]*anime-genres[^"]*"[^>]*>([\s\S]*?)<\/ul>/i;
        console.log(`Genres: ${genreRe.test(text) ? 'OK' : 'MISSING'}`);

    } catch (e) {
        console.error(`ANIME4UP Failed: ${e.message}`);
    }
}

async function run() {
    await testWitanimeDetails();
    await testAnime4upDetails();
}

run();
