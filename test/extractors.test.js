/**
 * Multi-server embed extractor tests (StreamWish / Vidas / YonaPlay / HGCloud).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let streamwish;
let vidas;
let yonaplay;
let generic;
let registry;
let hgcloud;
let support;

before(async () => {
  streamwish = await import('../src/extractors/streamwish.js');
  vidas = await import('../src/extractors/vidas.js');
  yonaplay = await import('../src/extractors/yonaplay.js');
  generic = await import('../src/extractors/generic.js');
  hgcloud = await import('../src/extractors/hgcloud.js');
  registry = await import('../src/extractors/registry.js');
  support = await import('../src/anime/providers/scraperSupport.js');
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
    assert.equal(streams[0].quality, 'FHD'); // Registry normalizes it later
    assert.equal(streams[1].url, 'https://cdn.streamwish.com/mp4/def.mp4');
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

  it('returns {sources: [], extractionStatus: "FAILED"} for unknown hosts', async () => {
    const result = await registry.resolveEmbed('https://unknown.example/e/abc');
    assert.deepEqual(result.sources, []);
    assert.equal(result.extractionStatus, 'FAILED');
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
      const result = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.equal(result.sources.length, 1);
      assert.equal(result.sources[0].provider, 'fake');
      assert.equal(result.extractionStatus, 'DIRECT');
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
      const result = await registry.resolveEmbed(`http://127.0.0.1:${server.port}/e/abc`, {
        extractors: [fakeExtractor],
        timeoutMs: 3000,
      });
      assert.deepEqual(result.sources, []);
      assert.equal(result.extractionStatus, 'FAILED');
    } finally {
      await server.stop();
    }
  });
});

// ── Shared candidate extraction ─────────────────────────────────────────────

describe('extractCandidates (shared)', () => {
  it('keeps the provider quality label verbatim (registry normalizes later)', () => {
    const html = `jwplayer().setup({ sources: [
      { file: "https://cdn.sub.example/hls/abc/index.m3u8", label: "جودة عالية" }
    ] });`;
    const streams = support.extractCandidates(html, { pageUrl: 'https://sub.example/e/1' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, 'جودة عالية');
  });

  it('extracts extensionless URLs that carry a media path shape', () => {
    const html = `
      <script>
        var playerCfg = { sources: [
          { file: "https://cdn.vidas.su/hls/9f3c2a" },
          { url: "https://cdn.hgcloud.io/media/abc123" },
          { src: "https://cdn.example.com/stream/xyz?token=t1" }
        ] };
        var theme = { src: "https://cdn.example.com/assets/theme.css" };
        var api = { url: "https://cdn.example.com/api/status.json" };
        var page = { src: "https://cdn.example.com/index.html" };
      </script>`;
    const streams = support.extractCandidates(html, { pageUrl: 'https://cdn.example.com/e/1' });
    const urls = streams.map((stream) => stream.url);
    assert.ok(urls.includes('https://cdn.vidas.su/hls/9f3c2a'), 'extensionless /hls/ url');
    assert.ok(urls.includes('https://cdn.hgcloud.io/media/abc123'), 'extensionless /media/ url');
    assert.ok(urls.includes('https://cdn.example.com/stream/xyz?token=t1'), 'extensionless /stream/ url with query');
    assert.ok(!urls.some((url) => url.includes('theme.css')), 'non-media .css never a candidate');
    assert.ok(!urls.some((url) => url.includes('status.json')), 'non-media .json never a candidate');
    assert.ok(!urls.some((url) => url.includes('index.html')), 'non-media .html never a candidate');
  });
});

// ── HGCloud ─────────────────────────────────────────────────────────────────

describe('hgcloud extractor', () => {
  it('matches HGCloud-family hosts and rejects others', () => {
    assert.equal(hgcloud.matches('https://hgcloud.to/e/abc'), true);
    assert.equal(hgcloud.matches('https://hglink.to/e/abc'), true);
    assert.equal(hgcloud.matches('https://highload.to/e/abc'), true);
    assert.equal(hgcloud.matches('https://highload.it/e/abc'), true);
    assert.equal(hgcloud.matches('https://vidas.su/e/abc'), false);
    assert.equal(hgcloud.matches('https://streamwish.to/e/abc'), false);
    assert.equal(hgcloud.matches('https://hgcloud.to.evil.example/e/abc'), false);
  });

  it('registry routes HGCloud hosts to the dedicated extractor (before generic)', () => {
    assert.equal(registry.extractorFor('https://hgcloud.to/e/abc')?.id, 'hgcloud');
    assert.equal(registry.extractorFor('https://hglink.to/e/abc')?.id, 'hgcloud');
    assert.equal(registry.extractorFor('https://vidas.su/embed/x')?.id, 'vidas');
  });

  it('assembles the stream URL from a base64 dictionary (b n = {...})', () => {
    const html = `
      <script>
        var _ = "obfuscated";
        b n = {"0":"aHR0cHM6Ly9jZG4u","1":"aGdjbG91ZC50by8=","2":"dmlkZW8vaW5kZXgubTN1OA=="};
      </script>`;
    const streams = hgcloud.extractStreams(html, { pageUrl: 'https://hgcloud.to/e/abc' });
    const urls = streams.map((stream) => stream.url);
    assert.ok(urls.includes('https://cdn.hgcloud.to/video/index.m3u8'), 'dict-assembled URL decoded');
  });

  it('assembles the stream URL from an atob() fragment chain', () => {
    const html = `
      <script>
        var u = atob("aHR0cHM6Ly9jZG4u") + atob("aGdjbG91ZC50by8=") + atob("dmlkZW8vaW5kZXgubTN1OA==");
      </script>`;
    const streams = hgcloud.extractStreams(html, { pageUrl: 'https://hgcloud.to/e/abc' });
    const urls = streams.map((stream) => stream.url);
    assert.ok(urls.includes('https://cdn.hgcloud.to/video/index.m3u8'), 'atob chain assembled');
  });

  it('keeps extensionless media declared via data-source attributes', () => {
    const html = `
      <div id="player" data-source="https://cdn.hgcloud.to/media/abc123"></div>
      <div id="theme" data-source="https://cdn.hgcloud.to/assets/theme.css"></div>`;
    const streams = hgcloud.extractStreams(html, { pageUrl: 'https://hgcloud.to/e/abc' });
    const urls = streams.map((stream) => stream.url);
    assert.ok(urls.includes('https://cdn.hgcloud.to/media/abc123'), 'extensionless data-source media');
    assert.ok(!urls.some((url) => url.includes('theme.css')), 'non-media data-source dropped');
  });

  it('recovers real sources from a packed loader after unpacking', () => {
    // unpackJs format: eval(function(p,a,c,k,e,d){return p}('PACKED',a,c,'k1|k2'.split('|')))
    const packed = 'file:"https://cdn.hgcloud.to/video/index.m3u8"';
    const html = `
      <script>
        eval(function(p,a,c,k,e,d){return p}('${packed}',1,1,''.split('|')))
      </script>`;
    const streams = hgcloud.extractStreams(html, { pageUrl: 'https://hgcloud.to/e/abc' });
    const urls = streams.map((stream) => stream.url);
    assert.ok(urls.includes('https://cdn.hgcloud.to/video/index.m3u8'), 'unpacked candidate recovered');
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
