import { EXTRACTORS } from './src/extractors/registry.js';

async function check() {
    console.log(`Checking ${EXTRACTORS.length} extractors...`);
    for (const e of EXTRACTORS) {
        try {
            console.log(`- ${e.id || 'NO_ID'}`);
            if (typeof e.matches !== 'function') console.warn(`  ! matches() is missing`);
            if (typeof e.extractStreams !== 'function') console.warn(`  ! extractStreams() is missing`);
        } catch (err) {
            console.error(`  ! FAILED to check ${e}:`, err.message);
        }
    }
}

check();
