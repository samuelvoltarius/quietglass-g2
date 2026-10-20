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

# The installed Even Hub app runs on an https origin: it may only call https://
# servers (an http:// daemon is blocked as mixed content and the app shows
# "Server muss https sein"). So the QR must carry the Tailscale HTTPS names.
# Detect existing `tailscale serve` mappings (read-only; this script never
# changes them): the https port proxying to :8787 is the daemon, the one
# proxying to :5210 is the app.
https_urls=""
if command -v tailscale >/dev/null 2>&1; then
  https_urls=$(tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
found = {}
for hostport, site in (data.get("Web") or {}).items():
    for handler in (site.get("Handlers") or {}).values():
        proxy = handler.get("Proxy", "")
        for port, key in (("8787", "server"), ("5210", "app")):
            if proxy.rstrip("/").endswith(":" + port) and ("127.0.0.1" in proxy or "localhost" in proxy):
                host, _, sport = hostport.rpartition(":")
                if not host:
                    host, sport = hostport, "443"
                found.setdefault(key, "https://" + host + ("" if sport == "443" else ":" + sport))
if "server" in found and "app" in found:
    print(found["server"], found["app"])
' || true)
fi

token=$(sed -n 's/^HUB_TOKEN=//p' .env-hub | head -n 1)
if [ -z "$token" ] || [ "$token" = "replace-with-a-long-random-token" ]; then
  echo "Set a real HUB_TOKEN in $app_dir/.env-hub" >&2
  exit 4
fi

if [ -n "$https_urls" ]; then
  server_url=${https_urls%% *}
  app_url=${https_urls##* }
else
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
  server_url="http://$host:8787"
  app_url="http://$host:5210"
  cat >&2 <<'WARN'
WARNING: no `tailscale serve` HTTPS mapping for the daemon (:8787) and the app (:5210) found.
The QR below uses plain http://. The installed Even Hub app (https) will REFUSE an
http:// server ("Server muss https sein"). Create the mappings once, e.g.
  tailscale serve --bg --https=8443 http://127.0.0.1:8787   # daemon
  tailscale serve --bg --https=8444 http://127.0.0.1:5210   # app
and run this script again.
WARN
fi

fragment=$(python3 - "$server_url" "$token" <<'PY'
import sys
from urllib.parse import urlencode
server, token = sys.argv[1], sys.argv[2]
print(urlencode({"server": server, "token": token}))
PY
)
url="$app_url/#$fragment"

echo "Quiet Hub services are running. Scan this QR in the Even App:"
# evenhub-cli prints the full URL (including our token) before the QR. Keep the
# terminal useful without leaking that credential into shell logs/history.
npx evenhub qr --url "$url" | sed '/^http.*#server=/d'
