#!/usr/bin/env bash
# One-command JENGA backend setup for a fresh Ubuntu box (Vultr).
#
#   ssh root@<ip>
#   curl -fsSL https://raw.githubusercontent.com/TheFJcurve/JENGA/feat/light-theme-map-zip-rox/deploy/setup-backend.sh | bash -s -- [domain]
#
# or clone first and run ./deploy/setup-backend.sh [domain].
#
# [domain] is what Caddy serves HTTPS on. HTTPS is not optional: the Vercel
# frontend is https, and browsers refuse mixed-content calls to http://ip:8000.
# With no argument this uses <public-ip>.sslip.io, which resolves to the box
# and gets a real Let's Encrypt certificate with zero DNS setup.
#
# Idempotent: safe to re-run for updates (git pull + pip install + restart).
set -euo pipefail

REPO="https://github.com/TheFJcurve/JENGA.git"
BRANCH="feat/light-theme-map-zip-rox"
APP_DIR="/opt/jenga"

PUBLIC_IP=$(curl -fsS https://api.ipify.org)
DOMAIN="${1:-${PUBLIC_IP}.sslip.io}"

echo "==> JENGA backend on ${DOMAIN} (ip ${PUBLIC_IP})"

# --- packages ---------------------------------------------------------------
apt-get update -qq
apt-get install -y -qq python3.11 python3.11-venv git curl debian-keyring debian-archive-keyring apt-transport-https >/dev/null

# Caddy: automatic HTTPS reverse proxy (official repo).
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

# --- code + venv -------------------------------------------------------------
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" fetch origin "${BRANCH}" && git -C "${APP_DIR}" checkout "${BRANCH}" && git -C "${APP_DIR}" pull
else
  git clone --branch "${BRANCH}" "${REPO}" "${APP_DIR}"
fi

cd "${APP_DIR}/backend"
[ -d .venv ] || python3.11 -m venv .venv
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt

# --- env file (never overwrite an existing one: it holds real keys) ----------
if [ ! -f /etc/jenga.env ]; then
  cp "${APP_DIR}/deploy/jenga.env.example" /etc/jenga.env
  chmod 600 /etc/jenga.env
  echo "==> Wrote /etc/jenga.env — EDIT IT to add your API keys, then:"
  echo "    systemctl restart jenga-backend"
fi

# --- systemd -----------------------------------------------------------------
cp "${APP_DIR}/deploy/jenga-backend.service" /etc/systemd/system/jenga-backend.service
systemctl daemon-reload
systemctl enable --now jenga-backend
systemctl restart jenga-backend

# --- Caddy: HTTPS in front of uvicorn ----------------------------------------
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:8000
}
EOF
systemctl reload caddy || systemctl restart caddy

# --- sanity ------------------------------------------------------------------
sleep 3
echo "==> local health:  $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/graph)"
echo "==> public health: $(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/graph")  (cert issue can take ~30s on first run)"
echo
echo "Backend URL for Vercel:  NEXT_PUBLIC_API_URL=https://${DOMAIN}"
echo "Add keys in /etc/jenga.env (presence check: grep -c '=' /etc/jenga.env), then: systemctl restart jenga-backend"
echo "Logs: journalctl -u jenga-backend -f"
