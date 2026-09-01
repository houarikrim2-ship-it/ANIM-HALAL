import { info } from './src/anime/providers/miruroProvider.js';

async function test() {
    console.log("Testing remote miruro.info...");
    try {
        const res = await info("20");
        console.log("RESULT:", res);
    } catch (e) {
        console.log("CAUGHT ERROR:", e.constructor.name);
        console.log("Message:", e.message);
        if (e.cause) console.log("Cause Message:", e.cause.message);
    }
}

test();
