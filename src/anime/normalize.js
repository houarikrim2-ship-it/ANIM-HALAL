/**
 * URL + response normalization for the anime source layer.
 */
import { DIRECT_MEDIA_URL_REGEX, MEDIA_MIME_TYPES, WATCH_EPISODE_ID_PATTERN } from './config.js';

export function normalizeUrl(raw, base = null) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
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
  } catch { return null; }
}

export function isDirectMediaUrl(url) {
  if (typeof url !== 'string') return false;
  const path = url.split('?')[0].split('#')[0].toLowerCase();
  if (DIRECT_MEDIA_URL_REGEX.test(url)) return true;
  if (path.includes('/hls/') || path.includes('/m3u8/')) return true;
  if (/playlist\.m3u8|master\.m3u8|chunklist\.m3u8|index\.m3u8|tracks-v\d+a\d+/i.test(path)) return true;
  if (/\.(ts|m4s|mp4|m4v|webm)$/i.test(path)) return true;
  // OK.ru / VK mirrors
  if (url.includes('vkuser.net')) return true;
  return false;
}

export function normalizeStreamSource(stream, context = {}) {
  if (stream === null || typeof stream !== 'object') return null;
  const rawUrl = stream.url ?? stream.file;
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
  const url = normalizeUrl(rawUrl, context.baseUrl ?? null);
  if (url === null) return null;

  const rawType = String(stream.type ?? '').toLowerCase();
  const isDirect = isDirectMediaUrl(url) || rawType === 'hls' || rawType === 'mp4' || rawType === 'progressive';
  const allowEmbeds = context.allowEmbeds === true;

  if (!isDirect && !allowEmbeds) return null;

  const isHls = isDirect && (/\.m3u8([?#]|$)/i.test(url) || rawType === 'hls');
  const type = isDirect
    ? (isHls ? 'hls' : (rawType === 'hls' ? 'hls' : 'progressive'))
    : (rawType === 'download' ? 'download' : 'embed');

  const mimeType = isDirect
    ? (stream.mimeType ?? MEDIA_MIME_TYPES[isHls ? 'hls' : detectMediaKind(url)] ?? 'application/octet-stream')
    : (stream.mimeType ?? (type === 'download' ? 'application/octet-stream' : 'text/html'));

  const headers = {};
  if (typeof stream.referer === 'string' && stream.referer.trim() !== '') headers.Referer = stream.referer.trim();
  if (typeof stream.origin === 'string' && stream.origin.trim() !== '') headers.Origin = stream.origin.trim();

  const subtitles = Array.isArray(stream.subtitles)
    ? stream.subtitles
        .map((sub) => normalizeSubtitle(sub, context.baseUrl ?? null))
        .filter((sub) => sub !== null)
    : [];

  return {
    url,
    name: typeof stream.name === 'string' && stream.name.trim() !== ''
      ? stream.name.trim()
      : context.providerName ?? 'unknown',
    type,
    quality: typeof stream.quality === 'string' && stream.quality.trim() !== ''
      ? stream.quality.trim()
      : typeof stream.label === 'string' && stream.label.trim() !== ''
        ? stream.label.trim()
        : 'auto',
    mimeType,
    isHls,
    isEmbed: !isDirect && type === 'embed',
    headers: Object.keys(headers).length > 0 ? headers : null,
    subtitles,
    provider:
      (typeof stream.provider === 'string' && stream.provider.trim() !== ''
        ? stream.provider.trim()
        : context.providerName) ?? 'unknown',
    language: context.language ?? 'sub',
    extractionStatus: stream.extractionStatus ?? (isDirect ? 'DIRECT' : (type === 'download' ? 'UNRESOLVED' : 'EMBED')),
    sourceKind: context.sourceKind ?? 'WATCH',
  };
}

function detectMediaKind(url) {
  const match = /\.(m3u8|mp4|webm|m4v)([?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : 'mp4';
}

export function normalizeSubtitle(sub, baseUrl = null) {
  if (sub === null || typeof sub !== 'object') return null;
  const rawUrl = sub.url ?? sub.file;
  if (typeof rawUrl !== 'string') return null;
  const url = normalizeUrl(rawUrl, baseUrl);
  if (url === null) return null;
  return {
    url,
    label: sub.label ?? sub.language ?? sub.lang ?? 'und',
    language: sub.lang ?? sub.language ?? 'und',
    mimeType: sub.mimeType ?? 'text/vtt',
  };
}

const QUALITY_RANK_GROUPS = [
  (q) => q.includes('fhd') || q.includes('1080'),
  (q) => q.includes('hd') || q.includes('720'),
  (q) => q.includes('sd') || q.includes('480'),
];

function qualityRank(quality) {
  const lower = String(quality ?? '').toLowerCase();
  const index = QUALITY_RANK_GROUPS.findIndex((matches) => matches(lower));
  return index === -1 ? QUALITY_RANK_GROUPS.length : index;
}

export function sortSourcesByQuality(sources) {
  if (!Array.isArray(sources)) return sources;
  return [...sources].sort((a, b) => {
    const byQuality = qualityRank(a.quality) - qualityRank(b.quality);
    if (byQuality !== 0) return byQuality;
    const byName = String(a.name ?? '').localeCompare(String(b.name ?? ''));
    if (byName !== 0) return byName;
    return String(a.url ?? '').localeCompare(String(b.url ?? ''));
  });
}

export function finalizeSources(sources) {
  if (!Array.isArray(sources)) return sources;
  const seen = new Set();
  const deduped = sources.filter((source) => {
    if (source === null || typeof source !== 'object' || typeof source.url !== 'string') return false;
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
  return sortSourcesByQuality(deduped);
}

export function parseWatchEpisodeId(episodeId) {
  if (typeof episodeId !== 'string') return null;
  const match = WATCH_EPISODE_ID_PATTERN.exec(episodeId.trim());
  if (match === null) return null;
  return {
    provider: match[1],
    anilistId: match[2],
    category: match[3],
    slug: match[4],
  };
}

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
          allowEmbeds: true,
          sourceKind: context.sourceKind ?? 'WATCH',
        }
      )
    )
    .filter((source) => source !== null);

  const seen = new Set();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
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
