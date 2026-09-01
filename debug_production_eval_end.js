import { fetchHtml } from './src/anime/providers/scraperSupport.js';

async function test() {
    const url = "https://playerwish.com/e/uynnctb0nuwx";
    try {
        const { text } = await fetchHtml(url, { timeoutMs: 10000 });
        const evalIndex = text.indexOf("eval(function(p,a,c,k,e,d)");
        if (evalIndex !== -1) {
            console.log("EVAL END:");
            // Find the end of the eval block by matching parentheses
            let depth = 0;
            let i = evalIndex + 4; // after 'eval'
            while (i < text.length) {
                if (text[i] === '(') depth++;
                else if (text[i] === ')') {
                    depth--;
                    if (depth === 0) break;
                }
                i++;
            }
            console.log(text.substring(i - 1000, i + 1));
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

test();
