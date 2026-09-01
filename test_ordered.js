import { ANIME_SCRAPER_PRIORITY } from './src/anime/config.js';

function orderedProviders() {
  const order = ANIME_SCRAPER_PRIORITY.length > 0
    ? ANIME_SCRAPER_PRIORITY
    : ['witanime', 'anime4up'];

  console.log("Order:", order);
  return order;
}

orderedProviders();
