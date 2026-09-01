import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function test() {
    const url = "https://playerwish.com/e/uynnctb0nuwx";
    try {
        const { text } = await fetchHtml(url, { timeoutMs: 10000 });
        console.log("BODY START:");
        console.log(text.substring(0, 4000));
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
