# Synclium Cloud

The optional hosted store for Synclium: a small object API over one SQLite file, at `https://synclium.skylive.world`.
Each sync group's encrypted files live in a vault named by the SHA-256 of a bearer token its sync key derives. The
server never sees the sync key or any plaintext, and has no accounts.

Losing its data loses nothing: devices republish everything on their next sync.

## Run and test

Node 24, no runtime dependencies.

```sh
npm ci
npm test
npm run typecheck
DATA_DIR=./data CLOUD_EPHEMERAL=1 npm start   # http://localhost:8080/v1/health
```

`CLOUD_EPHEMERAL=1` lets it start without a mounted volume. Without it, the server refuses to start when `DATA_DIR`
is on the container's own filesystem, because a redeploy would wipe it.

## Deploy

Coolify builds `Dockerfile` from this directory on each push to `main` that changes `cloud/`:

- project `synclium`, environment `production`, source `SkyliveLLC/synclium` on `main`, base directory `/cloud`, watch
  path `cloud/**` (set through the Coolify API; the CLI has no flag for it)
- port 8080, domain `https://synclium.skylive.world`, health check path `/v1/health`, memory limit 512m
- persistent storage mounted at `/data` (the database is `/data/cloud.sqlite`)
- DNS only, not proxied: the rate limits trust the last `X-Forwarded-For` entry, which Traefik appends

## Contract and limits

The routes are listed at the top of `src/app.ts`, and every limit (object size, vault quota, request rates, disk
guard, idle purge, timeouts) is in `src/limits.ts`.
