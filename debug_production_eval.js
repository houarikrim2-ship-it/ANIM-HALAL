import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function test() {
    const url = "https://playerwish.com/e/uynnctb0nuwx";
    try {
        const { text } = await fetchHtml(url, { timeoutMs: 10000 });
        const evalIndex = text.indexOf("eval(function(p,a,c,k,e,d)");
        if (evalIndex !== -1) {
            console.log("EVAL FOUND at index", evalIndex);
            console.log(text.substring(evalIndex, evalIndex + 500));
        } else {
            console.log("EVAL NOT FOUND");
            // Search for other patterns
            const scriptMatches = text.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
            if (scriptMatches) {
                console.log(`Found ${scriptMatches.length} scripts`);
                scriptMatches.forEach((s, i) => {
                    if (s.length > 500) console.log(`Script ${i} length: ${s.length}, sample: ${s.substring(0, 100)}...${s.slice(-100)}`);
                });
            }
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
