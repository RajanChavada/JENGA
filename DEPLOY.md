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

Claim credits, spin up the cheapest Ubuntu instance, then:

```bash
ssh root@<ip>
apt update && apt install -y python3.11 python3.11-venv git
git clone <repo> && cd jenga/backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
JENGA_OFFLINE=1 JENGA_STORAGE=memory \
  uvicorn main:app --host 0.0.0.0 --port 8000
```

Keep `JENGA_STORAGE=memory` unless you specifically want to demo the Postgres path — it removes
a whole class of 3am failure. Put it behind `tmux` or a systemd unit so an SSH drop doesn't kill
the demo.

Open port 8000 in the Vultr firewall.

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
