import { extractSources } from './src/anime/resolver.js';
import { AnimeApiError } from './src/anime/errors.js';

async function run() {
    const req = {
        body: {
            anilistId: "101280",
            title: "That Time I Got Reincarnated as a Slime Season 2 Part 2",
            episodeNumber: 1,
            category: "sub"
        }
    };

    try {
        const { anilistId, title, slug, episodeNumber, category } = req.body;
        const result = await extractSources({ anilistId, title, slug, episodeNumber, category });
        console.log("SUCCESS");
    } catch (err) {
        console.log("CAUGHT ERROR");
        console.log("instanceof AnimeApiError:", err instanceof AnimeApiError);
        console.log("Name:", err.name);
        console.log("Message:", err.message);
        console.log("Stack:", err.stack);
    }
}

run();
