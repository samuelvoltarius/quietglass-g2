#!/usr/bin/env sh
# One-command Pi setup/start plus an Even App QR code.
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$app_dir/../.." && pwd)
expected_dir="$HOME/quietglass-g2/apps/quiet-hub"

if [ "$app_dir" != "$expected_dir" ]; then
  echo "This service template expects the repository at $HOME/quietglass-g2" >&2
  echo "Current repository: $repo_dir" >&2
  exit 2
fi

cd "$app_dir"
if [ ! -f .env-hub ]; then
  cp .env-hub.example .env-hub
  token=$(openssl rand -hex 24)
  sed -i "s/^HUB_TOKEN=.*/HUB_TOKEN=$token/" .env-hub
  chmod 600 .env-hub
  echo "Created private .env-hub"
fi

if [ ! -d node_modules ]; then
  npm install
fi

mkdir -p "$HOME/.config/systemd/user"
install -m 0644 deploy/quiet-hub-daemon.service "$HOME/.config/systemd/user/quiet-hub-daemon.service"
install -m 0644 deploy/quiet-hub-app.service "$HOME/.config/systemd/user/quiet-hub-app.service"
systemctl --user daemon-reload
systemctl --user enable --now quiet-hub-daemon.service quiet-hub-app.service

host=${QUIET_HUB_HOST:-}
if [ -z "$host" ] && command -v tailscale >/dev/null 2>&1; then
  host=$(tailscale ip -4 2>/dev/null | head -n 1 || true)
fi
if [ -z "$host" ]; then
  host=$(hostname -I | awk '{print $1}')
fi
if [ -z "$host" ]; then
  echo "Could not determine Pi address. Run with QUIET_HUB_HOST=<ip> npm run pi:start" >&2
  exit 3
fi

token=$(sed -n 's/^HUB_TOKEN=//p' .env-hub | head -n 1)
if [ -z "$token" ] || [ "$token" = "replace-with-a-long-random-token" ]; then
  echo "Set a real HUB_TOKEN in $app_dir/.env-hub" >&2
  exit 4
fi

fragment=$(python3 - "$host" "$token" <<'PY'
import sys
from urllib.parse import urlencode
host, token = sys.argv[1], sys.argv[2]
print(urlencode({"server": f"http://{host}:8787", "token": token}))
PY
)
url="http://$host:5210/#$fragment"

echo "Quiet Hub services are running. Scan this QR in the Even App:"
# evenhub-cli prints the full URL (including our token) before the QR. Keep the
# terminal useful without leaking that credential into shell logs/history.
npx evenhub qr --url "$url" | sed '/^http.*#server=/d'
