#!/bin/sh
set -eu

if [ -z "${APP_SERVER_TOKEN:-}" ]; then
  echo "APP_SERVER_TOKEN is required" >&2
  exit 1
fi

codex_voice_token_file="/tmp/codex-voice-app-server-token"
codex_voice_listen="${APP_SERVER_LISTEN:-ws://0.0.0.0:4222}"
umask 077
printf '%s\n' "$APP_SERVER_TOKEN" > "$codex_voice_token_file"

exec codex --enable realtime_conversation app-server \
  --listen "$codex_voice_listen" \
  --ws-auth capability-token \
  --ws-token-file "$codex_voice_token_file"
