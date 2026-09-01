import { extractSources } from './anime/resolver.js';

async function probeMedia(url, headers = {}) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                ...headers,
                'Range': 'bytes=0-1023',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            },
            signal: controller.signal
        });
        clearTimeout(timeout);
        const contentType = res.headers.get('content-type') || 'none';
        const bodyText = await res.text();
        const isHls = bodyText.includes('#EXTM3U');
        const isHtml = bodyText.toLowerCase().includes('<html') || bodyText.toLowerCase().includes('<!doctype');
        const finalUrl = res.url;
        return { status: res.status, contentType, isHls, isHtml, finalUrl };
    } catch (e) {
        return { error: e.message };
    }
}

async function run() {
    console.log('--- NARUTO EPISODE 220 FINAL VERIFICATION ---');
    try {
        const result = await extractSources({
            anilistId: "20",
            title: "Naruto",
            episodeNumber: 220
        });

        console.log(`\nFinal API Data: ${result.sources.length} sources found\n`);

        for (const s of result.sources) {
            console.log(`\n[SOURCE] ${s.name} (${s.provider})`);
            console.log(`    Kind:      ${s.sourceKind}`);
            console.log(`    Status:    ${s.extractionStatus}`);
            console.log(`    Type:      ${s.type}`);
            console.log(`    isEmbed:   ${s.isEmbed}`);

            if (s.extractionStatus === 'DIRECT') {
                const p = await probeMedia(s.url, s.headers || {});
                console.log(`    Probe:     HTTP ${p.status} | Content-Type: ${p.contentType} | isHls: ${p.isHls} | isHtml: ${p.isHtml}`);

                // Logic from PlayerViewModel.kt
                const isVerifiedDirect = s.extractionStatus === "DIRECT";
                const isWatchEmbed = s.extractionStatus === "EMBED" && s.sourceKind === "WATCH";

                let action = "HIDDEN";
                if (isVerifiedDirect || isWatchEmbed) {
                    // Logic from resolveAndPlay
                    if (p.isHtml) {
                         action = "ERROR_OR_WEBVIEW (Resolved to HTML)";
                    } else if (p.isHls || p.contentType.includes('video/')) {
                         action = s.isEmbed ? "WEBVIEW" : "MEDIA3";
                    } else {
                         action = "ERROR (Unknown Type)";
                    }
                }
                console.log(`    Action:    ${action}`);
            } else {
                const isWatchEmbed = s.extractionStatus === "EMBED" && s.sourceKind === "WATCH";
                console.log(`    Action:    ${isWatchEmbed ? "WEBVIEW" : "HIDDEN"}`);
            }
        }

    } catch (e) {
        console.error('FAILED:', e.message);
    }
}

run();
