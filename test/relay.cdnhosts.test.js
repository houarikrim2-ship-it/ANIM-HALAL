/**
 * Relay CDN-host allowlist tests.
 *
 * StreamWish-family embed pages reference the real HLS manifest/segment CDNs
 * (e.g. premilkyway.com, jaketwish.com) that are NOT themselves embed hosts.
 * The relay must be allowed to fetch those exact hosts (and, with
 * UPSTREAM_ALLOW_SUBDOMAINS=true, their per-session CID subdomains) so a
 * genuine DIRECT HLS URL is playable instead of rejected with 403.
 *
 * This loadses the DEFAULT allowlist (no UPSTREAM_ALLOWED_HOSTS override) so
 * the production defaults are what is verified. Host matching is exact plus
 * boundary-aware subdomain matching: a prefix/suffix trick (evilpremilkyway.com,
 * premilkyway.com.evil.com) must never be allowed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

function loadDefaultConfig() {
  // Run in a fresh process with the allowlist override env var removed so the
  // module-level DEFAULT_ALLOWED_HOSTS is the effective list.
  const env = { ...process.env };
  delete env.UPSTREAM_ALLOWED_HOSTS;
  delete env.UPSTREAM_ALLOW_SUBDOMAINS;
  const script = `
    import('./src/config.js').then((m) => {
      const hosts = m.UPSTREAM_ALLOWED_HOSTS;
      const allowed = (h) => m.isHostAllowed(h);
      const sds = m.UPSTREAM_ALLOW_SUBDOMAINS;
      console.log(JSON.stringify({
        hosts, sds,
        cdnPremilkyway: allowed('premilkyway.com'),
        cdnPremilkywaySub: allowed('x123.premilkyway.com'),
        jaketwish: allowed('jaketwish.com'),
        evilPrefix: allowed('evilpremilkyway.com'),
        evilSuffix: allowed('premilkyway.com.evil.com'),
        playerwish: allowed('playerwish.com'),
        streamwish: allowed('streamwish.com')
      }));
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `config load failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('relay: default allowlist includes the streamwish CDN hosts with boundary-aware subdomains', () => {
  const cfg = loadDefaultConfig();
  assert.ok(cfg.hosts.includes('premilkyway.com'), 'premilkyway.com must be an allowlisted CDN host');
  assert.ok(cfg.hosts.includes('jaketwish.com'), 'jaketwish.com must be an allowlisted CDN host');
  assert.equal(cfg.sds, true, 'subdomain matching is enabled for provider CDNs');
});

test('relay: canonical streamwish-family CDN hosts are allowed', () => {
  const cfg = loadDefaultConfig();
  assert.equal(cfg.cdnPremilkyway, true);
  assert.equal(cfg.jaketwish, true);
  assert.equal(cfg.playerwish, true);
  assert.equal(cfg.streamwish, true);
});

test('relay: streamwish CDN subdomains are allowed with boundary checks', () => {
  const cfg = loadDefaultConfig();
  assert.equal(cfg.cdnPremilkywaySub, true, 'real CDN subdomain (x123.premilkyway.com) must be allowed');
  assert.equal(cfg.evilPrefix, false, 'evilpremilkyway.com must NOT be allowed (boundary check)');
  assert.equal(cfg.evilSuffix, false, 'premilkyway.com.evil.com must NOT be allowed (boundary check)');
});
