/**
 * URL + response normalization for the anime source layer.
 *
 * Providers return their own shapes; this module converts them into the
 * stable internal models consumed by the routes and the Android client.
 *
 * URL rules:
 * - absolute URLs pass through unchanged (signed URLs are never re-encoded)
 * - relative / protocol-relative URLs are resolved against their base
 * - non-http(s) URLs are rejected
 * - URLs are never double-encoded and query parameters are never rewritten
 */
import { DIRECT_MEDIA_URL_REGEX, MEDIA_MIME_TYPES, WATCH_EPISODE_ID_PATTERN } from './config.js';

/**
 * Normalizes [raw] against [base]. Returns null when the result is not a
 * usable http(s) URL.
 *
 * The original string is returned untouched when it is already an absolute
 * http(s) URL — this preserves signed URLs and their exact query strings.
 */
export function normalizeUrl(raw, base = null) {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    return null;
  }
  try {
    if (trimmed.startsWith('//')) {
      const resolved = new URL(trimmed, base ?? 'https://placeholder.invalid');
      return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    }
    if (base !== null) {
      const resolved = new URL(trimmed, base);
      return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when [url] looks like a directly playable media resource. */
export function isDirectMediaUrl(url) {
  return DIRECT_MEDIA_URL_REGEX.test(url);
}

/**
 * Normalizes a provider stream entry into the stable StreamSource model.
 *
 * Only directly playable media URLs (HLS playlists, MP4/WebM/M4V files) are
 * accepted. Embed pages, CAPTCHA pages and HTML endpoints are rejected with
 * [UNSUPPORTED_SOURCE] semantics (null return) — the provider layer is never
 * asked to bypass anti-bot protection.
 */
export function normalizeStreamSource(stream, context = {}) {
  if (stream === null || typeof stream !== 'object') {
    return null;
  }
  const rawUrl = stream.url ?? stream.file;
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return null;
  }
  const url = normalizeUrl(rawUrl, context.baseUrl ?? null);
  if (url === null || !isDirectMediaUrl(url)) {
    return null;
  }

  const isHls = /\.m3u8([?#]|$)/i.test(url);
  const rawType = String(stream.type ?? (isHls ? 'hls' : 'mp4')).toLowerCase();
  const type = isHls ? 'hls' : rawType === 'hls' ? 'hls' : 'progressive';
  const mimeType =
    stream.mimeType ??
    MEDIA_MIME_TYPES[isHls ? 'hls' : detectMediaKind(url)] ??
    'application/octet-stream';

  const headers = {};
  if (typeof stream.referer === 'string' && stream.referer.trim() !== '') {
    headers.Referer = stream.referer.trim();
  }
  if (typeof stream.origin === 'string' && stream.origin.trim() !== '') {
    headers.Origin = stream.origin.trim();
  }
  // Only honestly-declared playback headers are forwarded. Authentication
  // credentials, cookies and private tokens are never accepted here.

  const subtitles = Array.isArray(stream.subtitles)
    ? stream.subtitles
        .map((sub) => normalizeSubtitle(sub, context.baseUrl ?? null))
        .filter((sub) => sub !== null)
    : [];

  return {
    url,
    type,
    quality: typeof stream.quality === 'string' && stream.quality.trim() !== ''
      ? stream.quality.trim()
      : typeof stream.label === 'string' && stream.label.trim() !== ''
        ? stream.label.trim()
        : 'auto',
    mimeType,
    isHls,
    headers: Object.keys(headers).length > 0 ? headers : null,
    subtitles,
    provider: context.providerName ?? 'unknown',
    language: context.language ?? 'sub',
  };
}

function detectMediaKind(url) {
  const match = /\.(m3u8|mp4|webm|m4v)([?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : 'mp4';
}

/** Normalizes a subtitle track entry; null when unusable. */
export function normalizeSubtitle(sub, baseUrl = null) {
  if (sub === null || typeof sub !== 'object') {
    return null;
  }
  const rawUrl = sub.url ?? sub.file;
  if (typeof rawUrl !== 'string') {
    return null;
  }
  const url = normalizeUrl(rawUrl, baseUrl);
  if (url === null) {
    return null;
  }
  return {
    url,
    label: sub.label ?? sub.language ?? sub.lang ?? 'und',
    language: sub.lang ?? sub.language ?? 'und',
    mimeType: sub.mimeType ?? 'text/vtt',
  };
}

/** Parses a Miruro-style episode id ("watch/{provider}/{anilistId}/{category}/{slug}"). */
export function parseWatchEpisodeId(episodeId) {
  if (typeof episodeId !== 'string') {
    return null;
  }
  const match = WATCH_EPISODE_ID_PATTERN.exec(episodeId.trim());
  if (match === null) {
    return null;
  }
  return {
    provider: match[1],
    anilistId: match[2],
    category: match[3],
    slug: match[4],
  };
}

/**
 * Normalizes a Miruro watch response into a normalized source list.
 * Pipe payloads use either "streams" or "sources" as the array key, so both
 * are accepted. Non-direct-media entries (embed/HTML) are skipped, never
 * forwarded.
 */
export function normalizeWatchSources(watchResponse, context = {}) {
  const streams = Array.isArray(watchResponse?.streams)
    ? watchResponse.streams
    : Array.isArray(watchResponse?.sources)
      ? watchResponse.sources
      : [];
  const subtitles = Array.isArray(watchResponse?.subtitles) ? watchResponse.subtitles : [];

  const sources = streams
    .map((stream) =>
      normalizeStreamSource(
        { ...stream, subtitles: stream.subtitles ?? subtitles },
        {
          providerName: context.providerName ?? 'unknown',
          language: context.language ?? 'sub',
          baseUrl: context.baseUrl ?? null,
        }
      )
    )
    .filter((source) => source !== null);

  // Deduplicate by media URL (a provider may advertise the same stream twice).
  const seen = new Set();
  return sources.filter((source) => {
    if (seen.has(source.url)) {
      return false;
    }
    seen.add(source.url);
    return true;
  });
}

/**
 * Normalizes a Jikan anime object into the stable summary shape used by the
 * Android client (identical field names to the MiruroAPI summary contract).
 */
export function normalizeJikanAnime(anime) {
  if (anime === null || typeof anime !== 'object') {
    return null;
  }
  const malId = anime.mal_id;
  if (malId === undefined || malId === null) {
    return null;
  }
  const images = anime.images ?? {};
  const jpg = images.jpg ?? {};
  const webp = images.webp ?? {};
  const title = anime.title_english || anime.title || anime.title_japanese || '';
  return {
    id: `jikan_${malId}`,
    title: {
      romaji: anime.title ?? title,
      english: anime.title_english ?? title,
      native: anime.title_japanese ?? anime.title ?? '',
    },
    coverImage: {
      large: webp.large_image_url ?? jpg.large_image_url ?? jpg.image_url ?? '',
      extraLarge: webp.large_image_url ?? jpg.large_image_url ?? jpg.image_url ?? '',
    },
    bannerImage: '',
    format: anime.type ?? '',
    season: anime.season ?? '',
    seasonYear: anime.year ?? anime.aired?.prop?.from?.year ?? null,
    episodes: anime.episodes ?? null,
    duration: null,
    status: anime.status ?? '',
    averageScore: anime.score !== undefined && anime.score !== null ? Math.round(anime.score * 10) : null,
    popularity: anime.members ?? null,
    genres: (anime.genres ?? []).map((g) => g.name ?? '').filter((g) => g !== ''),
    description: anime.synopsis ?? '',
    studios: { nodes: (anime.studios ?? []).map((s) => ({ name: s.name ?? '', isAnimationStudio: null })) },
    startDate: { year: anime.aired?.prop?.from?.year ?? null, month: anime.aired?.prop?.from?.month ?? null, day: anime.aired?.prop?.from?.day ?? null },
    isAdult: false,
    provider: 'jikan',
  };
}

/**
 * Normalizes a Jikan episode row into the stable episode shape. Jikan never
 * exposes playable media, so [resolvable] is always false.
 */
export function normalizeJikanEpisode(animeId, episode) {
  const number = episode.mal_id ?? episode.episode;
  if (number === undefined || number === null) {
    return null;
  }
  return {
    id: `${animeId}_s1_ep${number}`,
    number,
    title: episode.title ?? '',
    image: '',
    airDate: episode.aired ?? '',
    audio: 'sub',
    filler: Boolean(episode.filler),
    provider: 'jikan',
    resolvable: false,
  };
}

/**
 * Normalizes a Miruro episode row. Miruro ids are opaque "watch/..." strings
 * the backend can resolve into sources, so [resolvable] is true when the id
 * parses correctly.
 */
export function normalizeMiruroEpisode(episode, providerName) {
  if (episode === null || typeof episode !== 'object') {
    return null;
  }
  const id = episode.id;
  const number = episode.number;
  if (typeof id !== 'string' || number === undefined || number === null) {
    return null;
  }
  return {
    id,
    number,
    title: episode.title ?? '',
    image: episode.image ?? '',
    airDate: episode.airDate ?? '',
    audio: String(episode.audio ?? 'sub').toLowerCase(),
    filler: Boolean(episode.filler),
    provider: providerName,
    resolvable: parseWatchEpisodeId(id) !== null,
  };
}