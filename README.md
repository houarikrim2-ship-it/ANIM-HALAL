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
