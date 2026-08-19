/**
 * Anime metadata + source-resolution routes.
 *
 * All responses use a stable envelope:
 *   success:  { success: true,  data: {...} }
 *   failure:  { success: false, error: { code, message } }
 *
 * Stream sources are served with Cache-Control: no-store (media URLs are
 * signed and expire). Metadata responses are cached server-side per TTL.
 */
import express from 'express';
import {
  animeCatalog,
  animeEpisodes,
  animeInfo,
  episodeSources,
  providerStatus,
  searchAnime,
} from '../anime/resolver.js';
import { AnimeApiError, ERROR_CODES } from '../anime/errors.js';

const router = express.Router();

function sendOk(res, data, { cacheControl = null } = {}) {
  if (cacheControl !== null) {
    res.set('Cache-Control', cacheControl);
  }
  res.json({ success: true, data });
}

function requireQuery(req, name) {
  const value = req.query?.[name];
  if (value === undefined || String(value).trim() === '') {
    throw new AnimeApiError(ERROR_CODES.INVALID_REQUEST, `Query parameter "${name}" is required`);
  }
  return String(value).trim();
}

router.get('/search', async (req, res, next) => {
  try {
    const q = requireQuery(req, 'q');
    const results = await searchAnime(q);
    sendOk(res, { results }, { cacheControl: 'public, max-age=60' });
  } catch (err) {
    next(err);
  }
});

for (const kind of ['trending', 'popular', 'recent', 'spotlight']) {
  router.get(`/${kind}`, async (req, res, next) => {
    try {
      const results = await animeCatalog(kind);
      sendOk(res, { results }, { cacheControl: 'public, max-age=60' });
    } catch (err) {
      next(err);
    }
  });
}

router.get('/info/:id', async (req, res, next) => {
  try {
    const info = await animeInfo(req.params.id);
    sendOk(res, info, { cacheControl: 'public, max-age=300' });
  } catch (err) {
    next(err);
  }
});

router.get('/episodes/:id', async (req, res, next) => {
  try {
    const episodes = await animeEpisodes(req.params.id);
    sendOk(res, episodes, { cacheControl: 'public, max-age=120' });
  } catch (err) {
    next(err);
  }
});

/**
 * Sources for one episode. [episodeId] is the opaque Miruro watch id, e.g.
 * "watch/kiwi/21/sub/kimetsu-no-yaiba-episode-1". Passed as a query
 * parameter because the value contains slashes that would make a path
 * segment ambiguous.
 */
router.get('/episode/sources', async (req, res, next) => {
  try {
    const episodeId = requireQuery(req, 'episodeId');
    const result = await episodeSources(episodeId);
    sendOk(res, result, { cacheControl: 'no-store' });
  } catch (err) {
    next(err);
  }
});

/** Provider diagnostics for operators. */
router.get('/providers', (_req, res) => {
  sendOk(res, providerStatus(), { cacheControl: 'no-store' });
});

export default router;