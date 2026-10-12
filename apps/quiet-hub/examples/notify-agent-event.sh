#!/usr/bin/env sh
# Generic completion hook for Claude, Codex, Hermes and OpenClaw.
# Usage: notify-agent-event.sh Codex done "Tests finished" "42 tests passed"
set -eu

provider=${1:?provider required}
status=${2:?status required: done, waiting or error}
title=${3:?title required}
detail=${4:-}
hub_url=${QUIET_HUB_URL:-http://127.0.0.1:8787}

if [ -z "${HUB_TOKEN:-}" ]; then
  echo "HUB_TOKEN is required" >&2
  exit 2
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'
}

payload=$(printf '{"provider":"%s","status":"%s","title":"%s","detail":"%s"}' \
  "$(json_escape "$provider")" "$(json_escape "$status")" \
  "$(json_escape "$title")" "$(json_escape "$detail")")

curl --fail --silent --show-error \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$payload" \
  "$hub_url/events"
