/**
 * Multi-server embed extractor registry.
 *
 * Scraper providers hand embed URLs (StreamWish / Vidas / YonaPlay player
 * pages) to [resolveEmbed], which:
 *   1. finds the extractor that owns the host,
 *   2. resolves it through the shared extractor pipeline (see resolver.js),
 *   3. returns every normalized source for the embed.
 *
 * Each extractor module additionally exposes a `resolve(embedUrl, context)`
 * contract method (spec §2) returning the single best {name, quality, url,
 * type, headers} entry — implemented by the same shared pipeline, so the
 * registry and the per-extractor entry points can never drift apart.
 *
 * Failure contract: one broken embed host NEVER breaks the request. Every
 * error is caught and logged; the server is simply omitted from the list.
 */
import { resolveWithExtractor } from './resolver.js';
import * as streamwish from './streamwish.js';
import * as vidas from './vidas.js';
import * as yonaplay from './yonaplay.js';
import * as hgcloud from './hgcloud.js';
import * as okru from './okru.js';
import * as mp4upload from './mp4upload.js';
import * as uqload from './uqload.js';
import * as voe from './voe.js';
import * as dood from './dood.js';
import * as vidbom from './vidbom.js';
import * as vidyard from './vidyard.js';
import * as gdrive from './gdrive.js';
import * as shared from './shared.js';
import * as generic from './generic.js';

/** Ordered extractor list; first match wins. */
export const EXTRACTORS = [
    streamwish,
    vidas,
    yonaplay,
    hgcloud,
    okru,
    mp4upload,
    uqload,
    voe,
    dood,
    vidbom,
    vidyard,
    gdrive,
    shared,
    generic
];

/** Returns the extractor module owning [url], or null. */
export function extractorFor(url, extractors = EXTRACTORS) {
  return extractors.find((extractor) => extractor.matches(url)) ?? null;
}

/**
 * Resolves one embed page into normalized StreamSource objects.
 *
 * @param {string} embedUrl
 * @param {object} options
 *   timeoutMs   per-request timeout (default ANIME_EXTRACTOR_TIMEOUT_MS)
 *   extractors  injectable extractor list (tests)
 * @returns {Promise<{sources: Array, error: string|null, status: number|null, extractionStatus: string}>} normalized sources.
 */
export async function resolveEmbed(embedUrl, options = {}) {
  const extractors = options.extractors ?? EXTRACTORS;
  const extractor = extractorFor(embedUrl, extractors);
  if (!extractor) {
    return { sources: [], error: 'No matching extractor found', extractionStatus: 'FAILED' };
  }
  return resolveWithExtractor(extractor, embedUrl, {
    timeoutMs: options.timeoutMs,
    sourceKind: options.sourceKind
  });
}
