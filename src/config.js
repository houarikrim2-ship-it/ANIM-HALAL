const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SRC_BYTES = 8192;
const DEFAULT_RETRY_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8000;

/**
 * Default authorized upstream hostnames. The relay MAY ONLY fetch from these
 * exact hosts (and their subdomains when UPSTREAM_ALLOW_SUBDOMAINS=true).
 * UPSTREAM_ALLOWED_HOSTS overrides this list when set.
 */
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'uqload.io',
  'uqload.is',
  'uqload.vc',
  'share4max.com',
  'anime4up.rest',
  'w1.anime4up.rest',
  '4d.h6m1c9q.shop',
  'hgcloud.to',
  'highload.it',
  'highload.link',
  'hglink.to',
  'highload.to',
  // Verified Direct Providers
  'streamwish.com',
  'streamwish.to',
  'hlswish.com',
  'playerwish.com',
  'wishembed.com',
  'wishplayer.com',
  'streamy.to',
  'stish.to',
  'embedwish.com',
  // StreamWish-family media CDNs. These are the canonical hosts that serve the
  // actual HLS manifests/segments (e.g. master.m3u8) referenced by the
  // playerwish/streamwish embed pages. Individual CDN subdomains
  // (cdn.* / x123.*) are matched exactly with boundary checks via
  // UPSTREAM_ALLOW_SUBDOMAINS and remain subject to every SSRF guard.
  'premilkyway.com',
  'jaketwish.com',
  'vidas.su',
  'vida.su',
  'yonaplay.net',
  'mp4upload.com',
  'yourupload.com',
  'vidcache.net',
  'ok.ru',
  'vkuser.net',
  'videas.fr',
  'vudeo.net',
  'vudeo.to',
  'videa.hu',
  'dailymotion.com',
]);

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  return parsed;
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${name}: expected a non-negative integer, got "${raw}"`);
  return parsed;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export const PORT = parseIntEnv('PORT', DEFAULT_PORT);
export const HOST = process.env.HOST || DEFAULT_HOST;
export const UPSTREAM_TIMEOUT_MS = parseIntEnv('UPSTREAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
export const UPSTREAM_MAX_REDIRECTS = parseIntEnv('UPSTREAM_MAX_REDIRECTS', DEFAULT_MAX_REDIRECTS);
export const MAX_MANIFEST_BYTES = parseIntEnv('MAX_MANIFEST_BYTES', DEFAULT_MAX_MANIFEST_BYTES);
export const MAX_SRC_BYTES = parseIntEnv('MAX_SRC_BYTES', DEFAULT_MAX_SRC_BYTES);
// Enabled by default to support common provider CDNs (cdn1..., ws2...)
export const UPSTREAM_ALLOW_SUBDOMAINS = boolEnv('UPSTREAM_ALLOW_SUBDOMAINS', true);

export const UPSTREAM_RETRY_MAX_ATTEMPTS = parseNonNegativeIntEnv('UPSTREAM_RETRY_MAX_ATTEMPTS', DEFAULT_RETRY_MAX_ATTEMPTS);
export const UPSTREAM_RETRY_BASE_DELAY_MS = parseIntEnv('UPSTREAM_RETRY_BASE_DELAY_MS', DEFAULT_RETRY_BASE_DELAY_MS);
export const UPSTREAM_RETRY_MAX_DELAY_MS = parseIntEnv('UPSTREAM_RETRY_MAX_DELAY_MS', DEFAULT_RETRY_MAX_DELAY_MS);

export const UPSTREAM_ALLOW_PRIVATE_RESOLUTION = boolEnv('UPSTREAM_ALLOW_PRIVATE_RESOLUTION', false);

const rawAllowlist = (process.env.UPSTREAM_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const effectiveAllowlist = rawAllowlist.length > 0 ? rawAllowlist : DEFAULT_ALLOWED_HOSTS;

if (effectiveAllowlist.length === 0) {
  throw new Error('UPSTREAM_ALLOWED_HOSTS is required. Refusing to start without an upstream host allowlist.');
}

export const UPSTREAM_ALLOWED_HOSTS = effectiveAllowlist;

export function isHostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return UPSTREAM_ALLOWED_HOSTS.some(
    (allowed) => host === allowed || (UPSTREAM_ALLOW_SUBDOMAINS && host.endsWith(`.${allowed}`))
  );
}

export function isIpv4Literal(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isForbiddenAddress(host) {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized.includes(':')) return true;
  if (!isIpv4Literal(normalized)) return false;
  const [a, b] = normalized.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export const UPSTREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PROVIDER_POLICY_KEYS = Object.freeze(['User-Agent', 'Referer', 'Origin']);

function parseProviderHeaders(raw) {
  const policy = new Map();
  if (raw === undefined || raw === '') return policy;
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('UPSTREAM_PROVIDER_HEADERS must be valid JSON');
  }
  for (const [host, headers] of Object.entries(parsed)) {
    const hostname = String(host).trim().toLowerCase().replace(/\.$/, '');
    if (hostname === '' || headers === null || typeof headers !== 'object') continue;
    const safe = {};
    for (const key of PROVIDER_POLICY_KEYS) {
      const value = headers[key];
      if (typeof value === 'string' && value.trim() !== '') safe[key] = value.trim();
    }
    if (Object.keys(safe).length > 0) policy.set(hostname, safe);
  }
  return policy;
}

const providerPolicy = parseProviderHeaders(process.env.UPSTREAM_PROVIDER_HEADERS);

export function providerHeadersFor(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  const exact = providerPolicy.get(host);
  if (exact !== undefined) return exact;
  let best = null, bestLength = 0;
  for (const [allowed, headers] of providerPolicy) {
    if (host.endsWith(`.${allowed}`) && allowed.length > bestLength) {
      best = headers;
      bestLength = allowed.length;
    }
  }
  return best;
}
