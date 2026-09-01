import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeStreamSource } from '../src/anime/normalize.js';

test('WATCH context with direct media should be DIRECT_MEDIA', () => {
    const stream = { url: "https://example.com/file.mp4", type: "progressive" };
    const context = { sourceKind: "WATCH", allowEmbeds: true };
    const result = normalizeStreamSource(stream, context);
    assert.equal(result.extractionStatus, "DIRECT");
    assert.equal(result.isEmbed, false);
});

test('DOWNLOAD context with no extractor should be UNRESOLVED and NOT isEmbed', () => {
    const stream = { url: "https://mega.nz/file/abc", type: "download" };
    const context = { sourceKind: "DOWNLOAD", allowEmbeds: true };
    const result = normalizeStreamSource(stream, context);
    assert.equal(result.extractionStatus, "UNRESOLVED");
    assert.equal(result.isEmbed, false);
});

test('WATCH context with known player should be EMBED and isEmbed', () => {
    const stream = { url: "https://ok.ru/videoembed/123", type: "embed" };
    const context = { sourceKind: "WATCH", allowEmbeds: true };
    const result = normalizeStreamSource(stream, context);
    assert.equal(result.extractionStatus, "EMBED");
    assert.equal(result.isEmbed, true);
});

test('HTML response (mismatched) should NOT be DIRECT_MEDIA', () => {
    // This part is handled by UrlResolver.kt in Android, but backend normalize
    // should still not mislabel it if it's not a direct media URL.
    const stream = { url: "https://example.com/page.html", type: "embed" };
    const context = { sourceKind: "WATCH", allowEmbeds: true };
    const result = normalizeStreamSource(stream, context);
    assert.equal(result.extractionStatus, "EMBED");
    assert.equal(result.isEmbed, true);
});
