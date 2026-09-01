import { unpackJs } from './src/anime/providers/scraperSupport.js';

const code = `eval(function(p,a,c,k,e,d){return p}('p', 1, 1, 'k', 0, {}))`;
console.log("Testing unpackJs with a=1...");
try {
    const unpacked = unpackJs(code);
    console.log("Result:", unpacked);
} catch (e) {
    console.error("FAILED:", e.message);
}
