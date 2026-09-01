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
  extractSources,
  getCatalogState,
  providerStatus,
  searchAnime,
} from '../anime/resolver.js';
import { AnimeApiError, ERROR_CODES } from '../anime/errors.js';
import { buildRelayPath } from '../hlsRewriter.js';

const router = express.Router();

function addProxyUrls(req, data) {
  if (!data?.sources || !Array.isArray(data.sources)) {
    return data;
  }
  const protocol = req.get('X-Forwarded-Proto') || req.protocol;
  const host = req.get('X-Forwarded-Host') || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  const sources = data.sources.map((s) => {
    if (s.isHls && s.url) {
      try {
        const relayPath = buildRelayPath('master', new URL(s.url), s.headers);
        return { ...s, proxyUrl: `${baseUrl}${relayPath}` };
      } catch (err) {
        console.error('[relay] failed to build proxyUrl:', err.message);
        return s;
      }
    }
    return s;
  });
  return { ...data, sources };
}

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

router.get('/catalog/state', (_req, res) => {
    sendOk(res, getCatalogState(), { cacheControl: 'no-store' });
});

router.get('/catalog/version', (_req, res) => {
    const state = getCatalogState();
    res.json({
        success: true,
        data: {
            revision: state.revision,
            lastUpdated: state.lastUpdated,
            hasChanges: true // Simplified
        }
    });
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
    sendOk(res, addProxyUrls(req, result), { cacheControl: 'no-store' });
  } catch (err) {
    next(err);
  }
});

/**
 * On-demand live extraction.
 * Request body: { anilistId, title, slug, episodeNumber, category? }
 */
router.post('/sources/extract', async (req, res, next) => {
  try {
    const { anilistId, title, slug, episodeNumber, category } = req.body;
    console.log(`[Resolver] POST /sources/extract anilistId=${anilistId}, title=${title}, slug=${slug}, ep=${episodeNumber}`);
    const result = await extractSources({ anilistId, title, slug, episodeNumber, category });
    console.log(`[Resolver] Success: found ${result.sources.length} sources`);
    sendOk(res, addProxyUrls(req, result), { cacheControl: 'no-store' });
  } catch (err) {
    console.error(`[Resolver] Extraction failed: ${err.message}`);
    next(err);
  }
});

/** Provider diagnostics for operators. */
router.get('/providers', (_req, res) => {
  sendOk(res, providerStatus(), { cacheControl: 'no-store' });
});

export default router;