import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function run() {
    const url = "https://w1.anime4up.rest/?s=One+Piece";
    console.log(`Fetching Search: ${url}`);
    const { text } = await fetchHtml(url);
    console.log(`Length: ${text.length}`);

    // Look for any link with "anime" in path
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    console.log('Links found:');
    while ((m = re.exec(text)) !== null) {
        if (m[1].includes('/anime/')) {
            console.log(`- ${m[2].trim().substring(0, 30)}: ${m[1]}`);
        }
    }
}

run();
