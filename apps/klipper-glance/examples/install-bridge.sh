#!/usr/bin/env bash
# Klipper Glance bridge - install in one go (only needed for use ON THE GO;
# at home the app reads Moonraker directly, no bridge).
#
#   curl -fsSL https://raw.githubusercontent.com/samuelvoltarius/quietglass-g2/main/apps/klipper-glance/examples/install-bridge.sh | bash
#
# Run it as your normal user on the Raspberry Pi of the printer (or any always-on
# Linux machine in its network). It needs sudo for the systemd service and for
# `tailscale serve`. Nothing is changed in Klipper or Moonraker.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/samuelvoltarius/quietglass-g2/main/apps/klipper-glance/examples"
DIR="$HOME/klipper-glance"
PORT="${KL_PORT:-8898}"
MOONRAKER="${KL_MOONRAKER:-http://127.0.0.1:7125}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/5  Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Node.js 18 or newer is missing - installing it (needs sudo)."
  sudo apt-get update -qq && sudo apt-get install -y -qq nodejs
fi
node --version
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "This system's Node.js is too old. Install Node 18+ from https://nodejs.org and run this again." >&2
  exit 1
fi

say "2/5  Bridge"
mkdir -p "$DIR"
curl -fsSL "$REPO_RAW/klipper-bridge.mjs" -o "$DIR/klipper-bridge.mjs"
echo "saved $DIR/klipper-bridge.mjs"

say "3/5  Moonraker"
if curl -fsS -m 4 "$MOONRAKER/printer/info" >/dev/null 2>&1; then
  echo "Moonraker answers at $MOONRAKER"
else
  echo "Moonraker does not answer at $MOONRAKER - the bridge will search the network itself."
  MOONRAKER=""
fi

say "4/5  Tailscale (for HTTPS from the phone)"
TS_USER=""
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  TS_USER="$(tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); uid=str(d["Self"]["UserID"]); print(d["User"][uid]["LoginName"])' 2>/dev/null || true)"
  echo "Tailscale is up${TS_USER:+, only $TS_USER gets in}."
else
  echo "Tailscale is not installed or not logged in. Install it (https://tailscale.com/download) and run this again"
  echo "to reach the bridge from your phone on the go. The service is set up anyway."
fi

say "5/5  Service"
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/klipper-glance.service >/dev/null <<EOF
[Unit]
Description=Klipper Glance bridge
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
Environment=PORT=$PORT
${MOONRAKER:+Environment=KL_MOONRAKER=$MOONRAKER}
${TS_USER:+Environment=KL_TAILSCALE_USERS=$TS_USER}
ExecStart=$NODE_BIN $DIR/klipper-bridge.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now klipper-glance
sleep 2
systemctl is-active klipper-glance >/dev/null && echo "klipper-glance service is running" || { echo "service failed - see: journalctl -u klipper-glance -n 30" >&2; exit 1; }

ADDRESS=""
if [ -n "$TS_USER" ]; then
  sudo tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null
  NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$NAME" ] && ADDRESS="https://$NAME:$PORT"
fi

say "Done."
if [ -n "$ADDRESS" ]; then
  echo "On the go, enter this in the Even app -> Klipper Glance -> Printer:"
  echo
  echo "    $ADDRESS"
else
  echo "The bridge runs on this machine, port $PORT. For use on the go, install Tailscale and run this script again."
fi
echo
echo "At home you can keep using the printer's IP directly - the bridge is only for the road."
