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

const data = {
    sources: [
        { url: "https://example.com/a.m3u8", isHls: true, headers: null }
    ]
};

console.log("Starting debug_final...");
try {
    const res = addProxyUrls({}, data);
    console.log("RESULT:", JSON.stringify(res));
} catch (e) {
    console.log("CRASHED:", e.message);
}
