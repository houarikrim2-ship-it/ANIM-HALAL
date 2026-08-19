const DEFAULT_PORT = 3001;
// Bind all interfaces by default. Platform containers (Render, Railway,
// Fly.io) probe the container's external interface; binding 127.0.0.1 there
// makes the port invisible ("no open ports detected on 0.0.0.0"). Local
// development can still pin HOST=127.0.0.1 explicitly.
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SRC_BYTES = 8192;

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
  // Multi-server embed hosts resolved by the extractor layer; their CDN
  // subdomains are covered by UPSTREAM_ALLOW_SUBDOMAINS=true by default.
  'streamwish.com',
  'streamwish.to',
  'vidas.su',
  'yonaplay.net',
]);

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export const PORT = parseIntEnv('PORT', DEFAULT_PORT);
export const HOST = process.env.HOST || DEFAULT_HOST;
export const UPSTREAM_TIMEOUT_MS = parseIntEnv('UPSTREAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
export const UPSTREAM_MAX_REDIRECTS = parseIntEnv('UPSTREAM_MAX_REDIRECTS', DEFAULT_MAX_REDIRECTS);
export const MAX_MANIFEST_BYTES = parseIntEnv('MAX_MANIFEST_BYTES', DEFAULT_MAX_MANIFEST_BYTES);
export const MAX_SRC_BYTES = parseIntEnv('MAX_SRC_BYTES', DEFAULT_MAX_SRC_BYTES);
export const UPSTREAM_ALLOW_SUBDOMAINS = boolEnv('UPSTREAM_ALLOW_SUBDOMAINS', false);

const rawAllowlist = (process.env.UPSTREAM_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const effectiveAllowlist = rawAllowlist.length > 0 ? rawAllowlist : DEFAULT_ALLOWED_HOSTS;

if (effectiveAllowlist.length === 0) {
  throw new Error(
    'UPSTREAM_ALLOWED_HOSTS is required and must list at least one authorized media hostname. ' +
      'Refusing to start without an upstream host allowlist.'
  );
}

export const UPSTREAM_ALLOWED_HOSTS = effectiveAllowlist;

/**
 * Boundary-aware allowlist match: exact host, or subdomain only when
 * UPSTREAM_ALLOW_SUBDOMAINS=true (host.endsWith(`.${allowed}`)). Lookalikes
 * such as `uqload.io.attacker.com` or `attacker-uqload.io` never match.
 */
export function isHostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return UPSTREAM_ALLOWED_HOSTS.some(
    (allowed) =>
      host === allowed || (UPSTREAM_ALLOW_SUBDOMAINS && host.endsWith(`.${allowed}`))
  );
}

/** True when `host` is a dotted-quad IPv4 literal. */
export function isIpv4Literal(host) {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * True for localhost, loopback, link-local, private, CGNAT, multicast and
 * reserved addresses (IPv4 literal or any IPv6). IP literals are never
 * allowed as upstream targets regardless of the allowlist.
 */
export function isForbiddenAddress(host) {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  if (normalized.includes(':')) {
    return true;
  }
  if (!isIpv4Literal(normalized)) {
    return false;
  }
  const [a, b] = normalized.split('.').map(Number);
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    a >= 224 // multicast + reserved
  );
}

export const UPSTREAM_USER_AGENT = 'anime-halal-relay/1.0';