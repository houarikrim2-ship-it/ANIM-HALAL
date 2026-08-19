/**
 * Multi-server embed extractor tests (StreamWish / Vidas / YonaPlay).
 *
 * Covers: per-host pattern matching, regex/JSON extraction, API-key
 * enrichment, registry normalization + validation (no private hosts, no
 * non-media), fail-soft behavior (unknown host, unreachable host, challenge
 * page, non-HTML answer, disabled switch -> empty list, never a throw).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let streamwish;
let vidas;
let yonaplay;
let registry;

before(async () => {
  streamwish = await import('../src/extractors/streamwish.js');
  vidas = await import('../src/extractors/vidas.js');
  yonaplay = await import('../src/extractors/yonaplay.js');
  registry = await import('../src/extractors/registry.js');
});

// ── StreamWish ─────────────────────────────────────────────────────────────

describe('streamwish extractor', () => {
  it('matches embed hosts and rejects non-streamwish URLs', () => {
    assert.equal(streamwish.matches('https://streamwish.com/e/abc123'), true);
    assert.equal(streamwish.matches('https://streamwish.to/e/abc123'), true);
    assert.equal(streamwish.matches('https://cdn.streamwish.com/e/abc123'), true);
    assert.equal(streamwish.matches('https://vidas.su/e/abc123'), false);
    assert.equal(streamwish.matches('https://streamwish.com.evil.example/e/abc'), false);
  });

  it('extracts jwplayer sources with labels and maps them to qualities', () => {
    const html = `
      <script>
        jwplayer("player").setup({
          sources: [
            { file: "https://cdn.streamwish.com/hls/abc/index.m3u8", label: "FHD" },
            { file: "https://cdn.streamwish.com/mp4/def.mp4", label: "HD" }
          ]
        });
      </script>`;
    const streams = streamwish.extractStreams(html, { pageUrl: 'https://streamwish.com/e/abc123' });
    assert.equal(streams.length, 2);
    assert.equal(streams[0].url, 'https://cdn.streamwish.com/hls/abc/index.m3u8');
    assert.equal(streams[0].quality, 'FHD');
    assert.equal(streams[1].url, 'https://cdn.streamwish.com/mp4/def.mp4');
    assert.equal(streams[1].quality, 'HD');
  });

  it('extracts clappr-style source arrays', () => {
    const html = `new Clappr.Player({ sources: ["https://cdn.streamwish.com/hls/ghi/index.m3u8"] });`;
    const streams = streamwish.extractStreams(html, { pageUrl: 'https://streamwish.to/e/abc123' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://cdn.streamwish.com/hls/ghi/index.m3u8');
  });

  it('ignores non-media URLs and dedupes repeats', () => {
    const html = `
      file: "https://streamwish.com/page.html"
      file: "https://cdn.streamwish.com/hls/abc/index.m3u8"
      file: "https://cdn.streamwish.com/hls/abc/index.m3u8"`;
    const streams = streamwish.extractStreams(html, { pageUrl: 'https://streamwish.com/e/abc123' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://cdn.streamwish.com/hls/abc/index.m3u8');
  });

  it('yields nothing for challenge/obfuscated payloads', () => {
    const html = '<html><body>Just a moment... checking your browser</body></html>';
    assert.deepEqual(streamwish.extractStreams(html, { pageUrl: 'https://streamwish.com/e/abc123' }), []);
  });
});

// ── Vidas ──────────────────────────────────────────────────────────────────

describe('vidas extractor', () => {
  it('matches vidas.su and vida.su hosts', () => {
    assert.equal(vidas.matches('https://vidas.su/embed/xyz'), true);
    assert.equal(vidas.matches('https://vida.su/embed/xyz'), true);
    assert.equal(vidas.matches('https://streamwish.com/e/xyz'), false);
  });

  it('extracts player_config, sources array, video and source elements', () => {
    const html = `
      <script>
        player_config = { "file": "https://cdn.vidas.su/hls/one/index.m3u8", "type": "hls" };
        var player = { "sources": [ { "src": "https://cdn.vidas.su/hls/two/index.m3u8",
                                      "type": "application/x-mpegURL" } ] };
      </script>
      <video src="https://cdn.vidas.su/mp4/three.mp4"></video>
      <source src="https://cdn.vidas.su/hls/four/index.m3u8" type="application/x-mpegURL">
    `;
    const streams = vidas.extractStreams(html, { pageUrl: 'https://vidas.su/embed/xyz' });
    assert.equal(streams.length, 4);
    assert.ok(streams.every((s) => /^https:\/\/cdn\.vidas\.su\//.test(s.url)));
  });

  it('dedupes and ignores non-media URLs', () => {
    const html = `
      "file": "https://vidas.su/embed/xyz"
      "file": "https://cdn.vidas.su/hls/one/index.m3u8"
      "file": "https://cdn.vidas.su/hls/one/index.m3u8"`;
    const streams = vidas.extractStreams(html, { pageUrl: 'https://vidas.su/embed/xyz' });
    assert.equal(streams.length, 1);
  });
});

// ── YonaPlay ───────────────────────────────────────────────────────────────

describe('yonaplay extractor', () => {
  it('matches yonaplay.net embeds', () => {
    assert.equal(yonaplay.matches('https://yonaplay.net/embed.php?id=12345'), true);
    assert.equal(yonaplay.matches('https://yonaplay.net/embed.php?id=12345&apiKey=abc'), true);
    assert.equal(yonaplay.matches('https://vidas.su/embed/xyz'), false);
  });

  it('appends the framework apiKey to plain embeds only', () => {
    const keyed = yonaplay.withApiKey('https://yonaplay.net/embed.php?id=12345');
    assert.match(keyed, /apiKey=9933bd27-92ea-4ee9-807d-e612029d6318$/);
    assert.equal(
      yonaplay.withApiKey('https://yonaplay.net/embed.php?id=12345&apiKey=existing'),
      'https://yonaplay.net/embed.php?id=12345&apiKey=existing',
    );
    assert.equal(
      yonaplay.withApiKey('https://yonaplay.net/other.php?id=1'),
      'https://yonaplay.net/other.php?id=1',
    );
  });

  it('parses JSON responses (data.file, sources array, top-level file)', () => {
    const json = JSON.stringify({
      success: true,
      data: { file: 'https://cdn.yonaplay.net/hls/one/index.m3u8' },
    });
    const fromData = yonaplay.extractStreams(json, { pageUrl: 'https://yonaplay.net/embed.php?id=1' });
    assert.equal(fromData.length, 1);
    assert.equal(fromData[0].url, 'https://cdn.yonaplay.net/hls/one/index.m3u8');

    const sourcesJson = JSON.stringify({
      content: 'x',
      sources: [{ file: 'https://cdn.yonaplay.net/mp4/two.mp4' }],
    });
    const fromSources = yonaplay.extractStreams(sourcesJson, { pageUrl: 'https://yonaplay.net/embed.php?id=1' });
    assert.equal(fromSources.length, 1);
    assert.equal(fromSources[0].url, 'https://cdn.yonaplay.net/mp4/two.mp4');

    const topLevel = yonaplay.extractStreams('{"file":"https://cdn.yonaplay.net/hls/three/index.m3u8"}', { pageUrl: 'x' });
    assert.equal(topLevel.length, 1);
  });

  it('falls back to inline-script regex when the response is HTML', () => {
    const html = `<script>var player = { "file": "https://cdn.yonaplay.net/hls/four/index.m3u8" };</script>`;
    const streams = yonaplay.extractStreams(html, { pageUrl: 'https://yonaplay.net/embed.php?id=2' });
    assert.equal(streams.length, 1);
  });

  it('ignores non-media values in JSON', () => {
    const json = JSON.stringify({
      data: { poster: 'https://cdn.yonaplay.net/poster.jpg', file: 'not-a-url' },
    });
    const streams = yonaplay.extractStreams(json, { pageUrl: 'https://yonaplay.net/embed.php?id=3' });
    assert.equal(streams.length, 0);
  });
});

// ── Registry ───────────────────────────────────────────────────────────────

describe('extractor registry', () => {
  it('resolves hosts to the owning extractor', () => {
    assert.equal(registry.extractorFor('https://streamwish.to/e/abc')?.id, 'streamwish');
    assert.equal(registry.extractorFor('https://vidas.su/embed/x')?.id, 'vidas');
    assert.equal(registry.extractorFor('https://yonaplay.net/embed.php?id=1')?.id, 'yonaplay');
    assert.equal(registry.extractorFor('https://unknown.example/e/abc'), null);
  });

  it('returns [] for unknown hosts without any network activity', async () => {
    const sources = await registry.resolveEmbed('https://unknown.example/e/abc');
    assert.deepEqual(sources, []);
  });

  it('normalizes extracted candidates through the injected extractor', async () => {
    const server = fakeServer(() => ({
      status: 200,
      contentType: 'text/html',
      body: `
      <script>jwplayer().setup({ sources: [
        { file: "https://cdn.example.com/hls/index.m3u8", label: "FHD" }
      ] });</script>`,
    }));
    await server.start();
    try {
      const fakeExtractor = {
        id: 'fake',
        matches: (url) => url.includes('127.0.0.1'),
        extractStreams: streamwish.extractStreams,
      };
      const sources = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.equal(sources.length, 1);
      assert.equal(sources[0].provider, 'fake');
      assert.equal(sources[0].quality, 'FHD');
      assert.equal(sources[0].url, 'https://cdn.example.com/hls/index.m3u8');
    } finally {
      await server.stop();
    }
  });

  it('drops private-host candidates but keeps public ones', async () => {
    const server = fakeServer(() => ({
      status: 200,
      contentType: 'text/html',
      body: `
      <script>
        var a = { file: "https://cdn.example.com/hls/pub/index.m3u8" };
        var b = { file: "http://10.0.0.5/hls/priv/index.m3u8" };
        var c = { file: "http://127.0.0.1/evil.m3u8" };
      </script>`,
    }));
    await server.start();
    try {
      const fakeExtractor = {
        id: 'fake',
        matches: (url) => url.includes('127.0.0.1'),
        extractStreams: vidas.extractStreams,
      };
      const sources = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.equal(sources.length, 1);
      assert.equal(sources[0].url, 'https://cdn.example.com/hls/pub/index.m3u8');
    } finally {
      await server.stop();
    }
  });

  it('omits the server when the embed answers a challenge page', async () => {
    const server = fakeServer(() => ({
      status: 200,
      contentType: 'text/html',
      body: '<html>Just a moment... checking your browser</html>',
    }));
    await server.start();
    try {
      const fakeExtractor = {
        id: 'fake',
        matches: (url) => url.includes('127.0.0.1'),
        extractStreams: streamwish.extractStreams,
      };
      const sources = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.deepEqual(sources, []);
    } finally {
      await server.stop();
    }
  });

  it('omits the server when the embed is unreachable (fail-soft, no throw)', async () => {
    const server = fakeServer(() => ({ status: 500, contentType: 'text/plain', body: 'boom' }));
    await server.start();
    try {
      const fakeExtractor = {
        id: 'fake',
        matches: (url) => url.includes('127.0.0.1'),
        extractStreams: streamwish.extractStreams,
      };
      const sources = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.deepEqual(sources, []);
    } finally {
      await server.stop();
    }
  });

  it('omits the server when the embed answers non-HTML/non-JSON', async () => {
    const server = fakeServer(() => ({ status: 200, contentType: 'text/plain', body: 'hello' }));
    await server.start();
    try {
      const fakeExtractor = {
        id: 'fake',
        matches: (url) => url.includes('127.0.0.1'),
        extractStreams: streamwish.extractStreams,
      };
      const sources = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.deepEqual(sources, []);
    } finally {
      await server.stop();
    }
  });

  it('honors the master switch (ANIME_EMBED_FOLLOW_ENABLED=false)', async () => {
    const previous = process.env.ANIME_EMBED_FOLLOW_ENABLED;
    process.env.ANIME_EMBED_FOLLOW_ENABLED = 'false';
    try {
      const sources = await registry.resolveEmbed('https://streamwish.to/e/abc');
      assert.deepEqual(sources, []);
    } finally {
      if (previous === undefined) {
        delete process.env.ANIME_EMBED_FOLLOW_ENABLED;
      } else {
        process.env.ANIME_EMBED_FOLLOW_ENABLED = previous;
      }
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeServer(responder) {
  let server = null;
  let port = 0;
  return {
    get port() {
      return port;
    },
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const answer = responder(port);
          res.writeHead(answer.status, { 'content-type': answer.contentType });
          res.end(answer.body);
        });
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve();
        });
        server.on('error', reject);
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (server) {
          server.close(resolve);
        } else {
          resolve();
        }
      });
    },
  };
}