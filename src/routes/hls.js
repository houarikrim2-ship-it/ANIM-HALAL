import { Router } from 'express';
import { MAX_MANIFEST_BYTES } from '../config.js';
import { looksLikePlaylist, rewriteManifest, validateSourceRef } from '../hlsRewriter.js';
import { fetchUpstream, UpstreamError } from '../upstreamClient.js';

const router = Router();

const PLAYLIST_MIME = 'application/vnd.apple.mpegurl; charset=utf-8';
const OCTET_MIME = 'application/octet-stream';
const DEFAULT_SEGMENT_MIME = 'video/mp2t';
const SAFE_PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
];
const RANGE_PATTERN = /^bytes=\d+-\d*$|^bytes=-\d+$/;

function isHtml(response) {
  const contentType = response.headers.get('content-type');
  return contentType ? /text\/html/i.test(contentType) : false;
}

function isPlaylistResponse(response, url) {
  const contentType = response.headers.get('content-type') ?? '';
  return looksLikePlaylist(url) || /mpegurl|vnd\.apple/i.test(contentType);
}

function sendError(res, err) {
  if (err instanceof UpstreamError && err.code === 'E_CLIENT_DISCONNECT') {
    return false;
  }
  if (res.headersSent) {
    res.destroy();
    return false;
  }
  const status = err instanceof UpstreamError ? err.status : 500;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(status).json({ error: err instanceof UpstreamError ? err.message : 'Internal server error' });
  return true;
}

function copySafeHeaders(res, response, skip = []) {
  for (const name of SAFE_PASSTHROUGH_HEADERS) {
    if (skip.includes(name)) {
      continue;
    }
    const value = response.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
}

function resolveSrc(req, res) {
  try {
    return validateSourceRef(req.query.src);
  } catch (err) {
    sendError(res, err);
    return null;
  }
}

/**
 * Non-OK upstream responses are NEVER streamed to the client. The body is
 * dropped and replaced with a JSON error so ExoPlayer/Media3 can never ingest
 * an HTML error page or Cloudflare challenge as media.
 * - 404 stays 404, 416 stays 416 (range negotiation is semantic and must
 *   reach the player intact with its Content-Range header).
 * - every other failure collapses to 502 Bad Gateway.
 */
function passthroughUpstreamStatus(res, response) {
  copySafeHeaders(res, response, ['content-type', 'content-length', 'cache-control']);
  const status =
    response.status === 404 || response.status === 416 ? response.status : 502;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(status).json({ error: `Upstream returned HTTP ${response.status}` });
}

async function readAll(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new UpstreamError('E_TOO_LARGE', 413, 'Upstream response exceeds the configured size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function pipeToResponse(res, response, stream, { forceContentType = null } = {}) {
  console.log(
    `[PROXY ROUTE] URL: ${response.url} | Status: ${response.status} | ` +
      `Content-Type: ${response.headers.get('content-type') ?? 'none'}`
  );
  copySafeHeaders(res, response);
  if (forceContentType) {
    res.setHeader('Content-Type', forceContentType);
  } else if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', DEFAULT_SEGMENT_MIME);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(response.status);
  res.flushHeaders();
  const startedAt = Date.now();
  stream.on('end', () => {
    console.log(
      `[relay] binary stream completed upstreamStatus=${response.status} ` +
        `contentType=${res.getHeader('Content-Type')} bytes=${res.getHeader('Content-Length') ?? 'chunked'} ` +
        `elapsedMs=${Date.now() - startedAt}`
    );
  });
  stream.on('error', (err) => {
    console.error(`[relay] binary stream error: ${err?.message}`);
    if (!res.writableEnded) {
      res.destroy();
    }
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      console.warn(`[relay] binary stream aborted by client upstreamStatus=${response.status} elapsedMs=${Date.now() - startedAt}`);
      stream.destroy();
    }
  });
  stream.pipe(res);
}

async function serveManifest(req, res, url, response, stream, srcHeaders) {
  console.log(
    `[PROXY ROUTE] URL: ${response.url} | Status: ${response.status} | ` +
      `Content-Type: ${response.headers.get('content-type') ?? 'none'}`
  );
  if (isHtml(response)) {
    stream.destroy();
    sendError(res, new UpstreamError('E_BAD_UPSTREAM', 502, 'Upstream returned an HTML page instead of a playlist'));
    return;
  }
  const text = await readAll(stream, MAX_MANIFEST_BYTES);
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.startsWith('#EXTM3U')) {
    throw new UpstreamError('E_BAD_UPSTREAM', 502, 'Upstream response is not a valid HLS playlist');
  }
  const rewritten = rewriteManifest(clean, response.url, srcHeaders);
  const body = Buffer.from(rewritten, 'utf8');
  copySafeHeaders(res, response, [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]);
  res.setHeader('Content-Type', PLAYLIST_MIME);
  res.setHeader('Content-Length', body.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.status(200).end(body);
}

router.get('/master.m3u8', async (req, res) => {
  const src = resolveSrc(req, res);
  if (!src) {
    return;
  }
  try {
    const { response, stream } = await fetchUpstream(req, res, src.url.href, {
      maxBytes: MAX_MANIFEST_BYTES,
      headers: src.headers,
    });
    if (!stream) {
      passthroughUpstreamStatus(res, response);
      return;
    }
    await serveManifest(req, res, src.url, response, stream, src.headers);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/segment', async (req, res) => {
  const src = resolveSrc(req, res);
  if (!src) {
    return;
  }
  const range = req.headers.range;
  if (range !== undefined && !RANGE_PATTERN.test(range.trim())) {
    res.setHeader('Accept-Ranges', 'bytes');
    res.status(416).json({ error: 'Invalid Range header' });
    return;
  }
  const upstreamHeaders = { ...src.headers };
  if (range !== undefined) {
    upstreamHeaders.Range = range.trim();
  }
  console.log(
    `[relay] segment request host=${src.url.hostname} path=${src.url.pathname} ` +
      `range=${range === undefined ? 'none' : range.trim()}`
  );
  try {
    const { response, stream } = await fetchUpstream(req, res, src.url.href, {
      headers: upstreamHeaders,
    });
    if (!stream) {
      passthroughUpstreamStatus(res, response);
      return;
    }
    if (isPlaylistResponse(response, src.url)) {
      await serveManifest(req, res, src.url, response, stream, src.headers);
      return;
    }
    if (isHtml(response)) {
      stream.destroy();
      sendError(res, new UpstreamError('E_BAD_UPSTREAM', 502, 'Upstream returned an HTML page instead of media'));
      return;
    }
    pipeToResponse(res, response, stream);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/key', async (req, res) => {
  const src = resolveSrc(req, res);
  if (!src) {
    return;
  }
  console.log(`[relay] key request host=${src.url.hostname} path=${src.url.pathname}`);
  try {
    const { response, stream } = await fetchUpstream(req, res, src.url.href, {
      maxBytes: MAX_MANIFEST_BYTES,
      headers: src.headers,
    });
    if (!stream) {
      passthroughUpstreamStatus(res, response);
      return;
    }
    if (isHtml(response)) {
      stream.destroy();
      sendError(res, new UpstreamError('E_BAD_UPSTREAM', 502, 'Upstream returned an HTML page instead of a key'));
      return;
    }
    pipeToResponse(res, response, stream, { forceContentType: OCTET_MIME });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;