import { buildRelayPath } from './src/hlsRewriter.js';

function addProxyUrls(req, data) {
  if (!data?.sources || !Array.isArray(data.sources)) {
    return data;
  }
  const protocol = "https";
  const host = "anim-halal.onrender.com";
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

const result = {
    provider: 'scraper',
    sources: [
        {
            url: "https://example.com/video.m3u8",
            isHls: true,
            headers: { "Referer": "https://source.com" }
        }
    ],
    fallbackProvider: 'witanime'
};

console.log("Testing addProxyUrls...");
try {
    const final = addProxyUrls({}, result);
    console.log("SUCCESS:", JSON.stringify(final, null, 2));
} catch (err) {
    console.error("FAILED:", err.message);
}
