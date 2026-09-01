import { AnimeApiError } from './src/anime/errors.js';

const err = new AnimeApiError('TEST', 'message');
console.log("instanceof:", err instanceof AnimeApiError);
console.log("Constructor Name:", err.constructor.name);
console.log("Name property:", err.name);
