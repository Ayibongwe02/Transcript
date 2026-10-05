# Knowledge Hub

Ask across meeting minutes, git, and connected sources (Zoom, Google Meet, Teams,
Slack, GitHub) with citations. Email + password accounts. Runs as a single
container — Postgres recommended, embedded PGLite as a fallback.

## Docker (production)

**Requirements:** Docker with Compose v2, Node is not needed on the host.

1. Copy `.env.example` to `.env` and set secrets:

```bash
cp .env.example .env
# BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# BETTER_AUTH_URL=http://localhost:10000   # must match the URL you open
```

2. Start:

```bash
# PGLite (no external database; accounts persist on the `kh_pglite` volume)
docker compose up --build

# Recommended: Postgres
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up --build
```

3. Open **http://localhost:10000** (use `localhost`, not `127.0.0.1`, unless
   you set `BETTER_AUTH_URL` to that origin) and create an account.

### Public / VPS deploy

| Variable | Why |
| --- | --- |
| `BETTER_AUTH_SECRET` | 32+ random bytes. Required by `docker compose`. Sessions invalidate if this changes. |
| `BETTER_AUTH_URL` | Exact public origin, e.g. `https://hub.example.com`. Sign-in fails with "Invalid origin" if this doesn't match the browser. |
| `DATABASE_URL` | Postgres URL. Apply-on-boot migrations create Better Auth tables. |
| `PORT` | Container listens on `10000` by default. Put TLS in front (Caddy, nginx, Render). **HTTPS is required** off localhost — auth cookies are `Secure`. |

Example behind a reverse proxy:

```bash
docker run --rm -p 10000:10000 \
  -e DATABASE_URL="postgres://hub:hub@db:5432/knowledge_hub" \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e BETTER_AUTH_URL="https://hub.example.com" \
  knowledge-hub
```

[Render](https://render.com) blueprint: `render.yaml` (web + managed Postgres).
No extra step is needed on the default `onrender.com` URL: the app picks up
Render's `RENDER_EXTERNAL_URL` automatically. If you attach a custom domain, set
`BETTER_AUTH_URL` to that HTTPS origin.

### Troubleshooting sign-in

| Symptom | Fix |
| --- | --- |
| `Invalid origin` (403) | Sign-in trusts the origin the request was actually sent to (Host / `X-Forwarded-Host` / `X-Forwarded-Proto`), so any URL you open the app at works: custom domain, LAN IP, mapped Docker port, http or https. If you still see it, your reverse proxy is rewriting `Host` without forwarding the original — pass `X-Forwarded-Host` and `X-Forwarded-Proto` (nginx: `proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme;`) or list the public URL in `BETTER_AUTH_TRUSTED_ORIGINS=https://hub.example.com`. Set `BETTER_AUTH_STRICT_ORIGINS=true` to trust only the fixed list. |
| `Too many requests` (429) | Run behind a proxy that sets `X-Forwarded-For` so each client gets its own rate-limit bucket. Sign-in allows 20/min and sign-up 10/min per bucket. |
| Sign-in "succeeds" but you stay signed out | Auth cookies are `Secure`; browsers only store them on HTTPS or `localhost`. Use HTTPS (or `localhost`) rather than a plain-HTTP LAN IP. |

### What the image does on boot

1. Makes the PGLite data directory writable, then drops to a non-root user.
2. Runs `scripts/migrate.mjs` when `DATABASE_URL` is set (no-op otherwise).
3. Starts the Nitro Node server on `0.0.0.0:$PORT`.

Health check: `GET /` must return < 500.

## Local development

```bash
npm install
npm run dev          # http://localhost:8080
npm run typecheck
npm test
npm run build:node   # production bundle used by Docker (`NITRO_PRESET=node-server`)
npm start            # serves `.output` (set PORT / BETTER_AUTH_* first)
```

## Desktop companion

Always-on-top live session overlay (mic / system audio). See `companion/README.md`.

```bash
cd companion && npm install
KH_URL=http://127.0.0.1:8080/minutes npm start
```
