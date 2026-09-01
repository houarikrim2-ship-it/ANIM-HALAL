import express from 'express';
import { extractSources } from './src/anime/resolver.js';
import { buildRelayPath } from './src/hlsRewriter.js';

function addProxyUrls(req, data) {
  if (!data?.sources || !Array.isArray(data.sources)) {
    return data;
  }
  const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  const host = req.get('X-Forwarded-Host') || req.get('host') || 'localhost';
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

async function test() {
    const req = {
        body: { anilistId: "20", episodeNumber: 1 },
        get: (name) => null,
        protocol: 'https'
    };

    console.log("Simulating route...");
    try {
        const result = {
            provider: 'scraper',
            sources: [
                { url: "https://example.com/a.m3u8", isHls: true, headers: null }
            ],
            fallbackProvider: null
        };
        const final = addProxyUrls(req, result);
        console.log("SUCCESS:", JSON.stringify(final, null, 2));
    } catch (err) {
        console.error("FAILED:", err.message);
    }
}

test();
