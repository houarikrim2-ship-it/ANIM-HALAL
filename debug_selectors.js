import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function debugWitanimeCover() {
    const url = "https://witanime.cyou/anime/one-piece/";
    const { text } = await fetchHtml(url);
    const imgRe = /<img[^>]+src="([^"]+)"/gi;
    let m;
    console.log('WITAnime Imgs:');
    while ((m = imgRe.exec(text)) !== null) {
        if (m[1].includes('uploads')) console.log(`- ${m[1]}`);
    }
}

async function debugAnime4upSearch() {
    const url = "https://w1.anime4up.rest/?search_param=animes&s=One+Piece";
    const { text } = await fetchHtml(url);
    const re = /<a\s+href="([^"]+)"[^>]*class="[^"]*anime-card-title[^"]*"[^>]*>(.*?)<\/a>/gi;
    let m;
    console.log('\nAnime4Up Search Results:');
    while ((m = re.exec(text)) !== null) {
        console.log(`- ${m[2].trim()}: ${m[1]}`);
    }
}

async function run() {
    await debugWitanimeCover();
    await debugAnime4upSearch();
}

run();
