# Anime Halal HLS backend

Place this `backend` folder beside Android's `app` folder:

```text
anime-halal/
├─ app/
└─ backend/
   ├─ package.json
   └─ src/
```

## Start it

1. Install Node.js 20 or newer.
2. Open a terminal in `anime-halal/backend`.
3. Run `npm install`.
4. Set `UPSTREAM_ALLOWED_HOSTS` to the authorized HLS origin hostname(s), then run `npm start`.

PowerShell example:

```powershell
$env:UPSTREAM_ALLOWED_HOSTS = 'media.example.com'
npm start
```

The Android emulator reaches this server through `http://10.0.2.2:3000`.

The server only accepts `http`/`https` upstream URLs whose hostnames match the explicit allowlist. It does not forward device cookies or authorization headers, and it is intended only for media origins you are authorized to access.

## Anime source-resolution layer

The backend also exposes a normalized anime metadata + stream-source API under `/api/anime`. It aggregates MiruroAPI (metadata + streaming sources) and Jikan (metadata only) behind one contract, so the Android client never touches scraper internals.

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANIME_API_BASE_URL` | `https://mirurotvapi.vercel.app` | Self-hosted MiruroAPI instance; the public one may be paused |
| `ANIME_JIKAN_BASE_URL` | `https://api.jikan.moe/v4` | Jikan v4 metadata endpoint |
| `ANIME_PROVIDER_ENABLED` | `true` | Master switch for MiruroAPI |
| `ANIME_JIKAN_ENABLED` | `true` | Master switch for Jikan |
| `ANIME_PROVIDER_TIMEOUT_MS` | `15000` | Per-attempt upstream timeout |
| `ANIME_MAX_ATTEMPTS` | `2` | Retries on transient failures (429/5xx/network) |
| `ANIME_PROVIDER_PRIORITY` | `kiwi,pewe,bee,bonk,bun,ally,nun,twin,cog,moo,hop,telli` | Episode dedup + fallback order |
| `ANIME_SEARCH_CACHE_TTL_MS` | `60000` | Search cache TTL |
| `ANIME_INFO_CACHE_TTL_MS` | `300000` | Info cache TTL |
| `ANIME_EPISODES_CACHE_TTL_MS` | `120000` | Episodes cache TTL |
| `ANIME_SCRAPER_ENABLED` | `true` | Master switch for the HTML scraper fallback chain |
| `ANIME_WITANIME_BASE_URL` | `https://witanime.com` | WitAnime mirror for the scraper fallback |
| `ANIME_ANIME4UP_BASE_URL` | `https://anime4up.rest` | Anime4Up mirror for the scraper fallback |
| `ANIME_SCRAPER_TIMEOUT_MS` | `12000` | Per-page scraper timeout |
| `ANIME_SCRAPER_PRIORITY` | `witanime,anime4up` | Scraper fallback order |

Stream sources are never cached (media URLs are signed and expire).

### Scraper fallback chain

When MiruroAPI yields no playable source for an episode, the resolver searches the scraper sites (WitAnime, then Anime4Up) by title, resolves the same episode number, and extracts only **directly playable media URLs** from the page HTML. The Android client never contacts these hosts: every extracted URL is served through the HLS relay, which re-validates the host against `UPSTREAM_ALLOWED_HOSTS` at playback time (scraped hosts not in the allowlist are blocked by design).

Scraper requests use browser-like headers (UA/Referer/Origin matching the site) with bounded timeouts and per-provider failure isolation (structured categories: `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `SOURCE_NOT_FOUND`, `UPSTREAM_BLOCKED`, `EXTRACTION_FAILED`, `ALL_PROVIDERS_FAILED`). Anti-bot challenges are detected and classified `UPSTREAM_BLOCKED` — they are never solved or bypassed, and the chain simply moves to the next provider. Extracted URLs are validated (http(s) only; loopback/private/link-local/reserved hosts rejected) and embed pages are never forwarded.

### Endpoints

All responses use a stable envelope: `{ success: true, data }` or `{ success: false, error: { code, message } }`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/anime/search?q=…` | Search across providers |
| `GET` | `/api/anime/info/:id` | Full metadata (`<anilistId>` or `jikan_<malId>`) |
| `GET` | `/api/anime/episodes/:id` | Episode list (resolvable episodes only) |
| `GET` | `/api/anime/episode/sources?episodeId=watch/…` | Playable sources, with cross-provider fallback |
| `GET` | `/api/anime/providers` | Provider diagnostics |

Episode ids are the opaque Miruro `watch/{provider}/{anilistId}/{category}/{slug}` strings. When the requested provider fails, the resolver retries the **same episode number and language** on the other Miruro providers in priority order — anime identity is preserved by construction. If MiruroAPI yields nothing at all, the scraper fallback chain (see above) takes over as the last resort.

Stable error codes: `INVALID_REQUEST`, `ANIME_NOT_FOUND`, `EPISODE_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `STREAM_UNAVAILABLE`, `UNSUPPORTED_SOURCE`, `RATE_LIMITED`, `UPSTREAM_BLOCKED`, `NETWORK_ERROR`, `TIMEOUT`, `INTERNAL_ERROR`. The layer only ever returns directly playable media URLs (HLS/MP4/WebM); embed pages and anti-bot challenges are never forwarded or bypassed.
