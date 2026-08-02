#!/bin/sh
set -eu

if [ -z "${APP_SERVER_TOKEN:-}" ]; then
  echo "APP_SERVER_TOKEN is required" >&2
  exit 1
fi

codex_voice_token_file="/tmp/codex-voice-app-server-token"
codex_voice_listen="${APP_SERVER_LISTEN:-ws://0.0.0.0:4222}"
codex_voice_git_config="${GIT_CONFIG_GLOBAL:-/tmp/codex-voice-gitconfig}"
export GIT_CONFIG_GLOBAL="$codex_voice_git_config"
umask 077
printf '%s\n' "$APP_SERVER_TOKEN" > "$codex_voice_token_file"

if gh auth status --hostname github.com >/dev/null 2>&1; then
  if gh auth setup-git --hostname github.com \
    && git config --global --replace-all url.https://github.com/.insteadOf 'git@github.com:' \
    && git config --global --add url.https://github.com/.insteadOf 'ssh://git@github.com/'
  then
    echo "Configured authenticated GitHub HTTPS access for gh and git."
  else
    echo "Warning: GitHub CLI is authenticated, but git credential setup failed." >&2
  fi
else
  echo "GitHub CLI credentials were not found; continuing without authenticated gh/git access." >&2
fi

exec codex --enable realtime_conversation app-server \
  --listen "$codex_voice_listen" \
  --ws-auth capability-token \
  --ws-token-file "$codex_voice_token_file"
