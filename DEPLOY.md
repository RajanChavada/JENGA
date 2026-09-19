# Deploy

Demo from `localhost` if you can — it's faster and has no cold starts. Hosting exists so judges
and teammates can hit a URL, and because Vultr is a sponsor track.

## Frontend → Vercel

```bash
cd frontend
npx vercel --prod
```

Set in the Vercel dashboard:
```
NEXT_PUBLIC_API_URL=https://<backend-host>
```

Fully static fallback if the backend isn't up yet — set `NEXT_PUBLIC_USE_FIXTURES=1` and the app
runs entirely on `data/*.json`. The demo works with nothing else deployed.

## Backend → Vultr (sponsor track)

**HTTPS is not optional.** The Vercel frontend is served over https, and browsers refuse
mixed-content calls to `http://<ip>:8000` — every request would fail silently in the demo.
The setup script puts Caddy (automatic Let's Encrypt) in front of uvicorn.

Claim credits, spin up the cheapest Ubuntu instance, then one command:

```bash
ssh root@<ip>
curl -fsSL https://raw.githubusercontent.com/TheFJcurve/JENGA/feat/light-theme-map-zip-rox/deploy/setup-backend.sh | bash
```

That installs Python + Caddy, clones the repo to `/opt/jenga`, creates the venv, writes a
systemd unit (`jenga-backend`, restarts on crash and reboot), and serves HTTPS on
`<ip>.sslip.io` — a real certificate with zero DNS setup. Pass your GoDaddy domain as an
argument once its A record points at the box: `... | bash -s -- api.yourdomain.com`.

Then add keys (all optional — each flips a mock to live) and restart:

```bash
nano /etc/jenga.env        # OPENAI_API_KEY, GPTZERO_API_KEY, ZIP_API_KEY, BROWSERBASE_*
systemctl restart jenga-backend
journalctl -u jenga-backend -f
```

Firewall: allow **80 and 443** (Caddy). Port 8000 stays loopback-only.

Keep `JENGA_STORAGE=memory` unless you specifically want to demo the Postgres path — it removes
a whole class of 3am failure.

## Domain → GoDaddy (sponsor track)

Register something, point an A record at the Vultr IP or CNAME to Vercel. Five minutes, one
prize. Do it while a build is running.

## Postgres, if you want it

Either `docker compose up -d` on the same Vultr box, or any managed pgvector instance. Then:

```bash
JENGA_STORAGE=postgres DATABASE_URL=postgresql+asyncpg://... uvicorn main:app --host 0.0.0.0
```

`POST /api/reset` reseeds from `data/seed_tasks.json`.

## Sanity check before you demo

```bash
curl https://<backend>/api/graph | head -c 300
curl -X POST https://<backend>/api/reset
```

Then run `DEMO.md` end to end against the deployed URL once. Do not let the first end-to-end run
be in front of a judge.
