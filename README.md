# Copy Paste Text

A tiny password-protected remote notepad. Log in from any device, paste text, and copy it from another device. Changes autosave and sync every few seconds.

No dependencies — just Node 18+.

## Run locally

```sh
APP_PASSWORD=choose-a-password npm start
# open http://localhost:3000
```

## Configuration (environment variables)

| Variable         | Required | Description |
|------------------|----------|-------------|
| `APP_PASSWORD`   | yes      | Login password |
| `APP_USERNAME`   | no       | Login username (default `admin`) |
| `SESSION_SECRET` | no*      | Long random string used to sign login cookies. *Set it in production or everyone is logged out on each restart. |
| `DATA_DIR`       | no       | Where the note is stored (default `./data`). Mount a persistent volume here. |
| `PORT`           | no       | Port to listen on (default `3000`) |

## Deploy

### Render (easiest)
1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick this repo. `render.yaml` sets up the Docker service and a 1 GB disk at `/data`.
3. Enter `APP_PASSWORD` when prompted. Render generates `SESSION_SECRET`.

Render provides HTTPS automatically. Note that persistent disks need a paid plan; on a free plan the note is lost whenever the service restarts.

### Any Docker host (Fly.io, Railway, VPS…)
```sh
docker build -t copy-paste-text .
docker run -d -p 3000:3000 -v notepad:/data \
  -e APP_PASSWORD=choose-a-password \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  copy-paste-text
```
Put it behind HTTPS (Caddy, nginx, or your platform's proxy) — otherwise your password travels in plain text.

## Security notes
- Single shared user; login is rate-limited to 5 failed attempts per IP per 15 minutes.
- Session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when served over HTTPS.
- Don't paste things you wouldn't trust to a small self-hosted service; the note is stored unencrypted in `DATA_DIR`.
