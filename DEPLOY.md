# Deploy

Demo from `localhost` if you can — it's faster and has no cold starts. Hosting exists so judges
and teammates can hit a URL, and because Vultr is a sponsor track.

## The two GitHub repos, and how they stay in sync

Both repos carry the full app on `main` (synced 2026-09-19):

- **https://github.com/RajanChavada/JENGA** — team repo, `main` accepts direct pushes. Vercel
  should watch this one.
- **https://github.com/TheFJcurve/JENGA** — `main` is protected: PR-only, squash/rebase merges.

The local checkout's `origin` remote is configured with **two push URLs**, so one command
updates the feature branch on both repos:

```bash
git push origin feat/light-theme-map-zip-rox     # lands on BOTH repos
```

(A GitHub Actions mirror was considered and rejected: the default `GITHUB_TOKEN` cannot push
to a different repository, and we have no cross-repo PAT to store as a secret.)

Updating `main` after new work on the branch:

```bash
# RajanChavada (direct merge allowed):
gh pr create --repo RajanChavada/JENGA --base main --head feat/light-theme-map-zip-rox --fill
gh pr merge --repo RajanChavada/JENGA --merge

# TheFJcurve (PR-only, no merge commits):
git push origin feat/light-theme-map-zip-rox:sync-main-full-app
gh pr create --repo TheFJcurve/JENGA --base main --head sync-main-full-app --fill
gh pr merge --repo TheFJcurve/JENGA --squash
```

## Frontend → Vercel

One-time setup (interactive login, then link + deploy):

```bash
cd frontend
npx vercel login                 # browser auth
npx vercel link                  # create the project (root = frontend/)
npx vercel env add NEXT_PUBLIC_USE_FIXTURES production   # value: 1 (until the backend is live)
npx vercel --prod
```

Then connect GitHub for auto-deploys on every push to `main`:

```bash
npx vercel git connect https://github.com/RajanChavada/JENGA
```

In the Vercel dashboard set the project **Root Directory to `frontend/`** (the repo root also
contains the portal app and the FastAPI backend). Once the backend is hosted, replace the
fixtures flag:

```
NEXT_PUBLIC_API_URL=https://<backend-host>   # and remove NEXT_PUBLIC_USE_FIXTURES
```

Fully static fallback if the backend isn't up yet — `NEXT_PUBLIC_USE_FIXTURES=1` runs the app
entirely on `data/*.json`. The demo works with nothing else deployed.

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
