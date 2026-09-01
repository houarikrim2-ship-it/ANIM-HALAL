import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function probe() {
    const urls = [
        "https://witanime.cyou/?s=Naruto&search_param=animes",
        "https://w1.anime4up.rest/?search_param=animes&s=Naruto"
    ];

    for (const url of urls) {
        console.log(`--- Probing ${url} ---`);
        try {
            const { text, finalUrl, status } = await fetchHtml(url, { timeoutMs: 10000 });
            console.log(`Status: ${status}`);
            console.log(`Final URL: ${finalUrl}`);
            console.log(`Body Length: ${text.length}`);
            console.log(`Body sample: ${text.substring(0, 500)}`);
        } catch (e) {
            console.log(`FAILED: ${e.message}`);
            if (e.status) console.log(`Status: ${e.status}`);
            if (e.failureCategory) console.log(`Category: ${e.failureCategory}`);
        }
    }
}

probe();
