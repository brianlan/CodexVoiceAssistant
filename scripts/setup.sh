#!/bin/sh
set -eu

if [ -e .env ]; then
  echo ".env already exists; refusing to overwrite it."
  exit 0
fi

codex_voice_ip="${APP_HOST_IP:-}"
if [ -z "$codex_voice_ip" ] && command -v ip >/dev/null 2>&1; then
  codex_voice_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
fi
if [ -z "$codex_voice_ip" ]; then
  codex_voice_ip="127.0.0.1"
fi

codex_voice_user_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
if [ -z "$codex_voice_user_home" ]; then
  codex_voice_user_home="${HOME}"
fi

codex_voice_password="$(openssl rand -hex 16)"
codex_voice_token="$(openssl rand -hex 32)"
codex_voice_workspace="$(pwd -P)"

mkdir -p "$codex_voice_user_home/.codex/skills"

umask 077
{
  printf '%s\n' "APP_HOST_IP=$codex_voice_ip"
  printf '%s\n' "APP_PORT=3000"
  printf '%s\n' "APP_PASSWORD=$codex_voice_password"
  printf '%s\n' "APP_SERVER_TOKEN=$codex_voice_token"
  printf '%s\n' "SESSION_TTL_HOURS=12"
  printf '%s\n' "HOST_WORKSPACE=$codex_voice_workspace"
  printf '%s\n' "HOST_CODEX_HOME=$codex_voice_user_home/.codex"
  printf '%s\n' "HOST_UID=$(id -u)"
  printf '%s\n' "HOST_GID=$(id -g)"
  printf '%s\n' "CODEX_PERMISSION_MODE=workspace-write"
  printf '%s\n' "CODEX_VERSION=0.146.0"
  printf '%s\n' "CODEX_MODEL="
  printf '%s\n' "CODEX_REASONING_EFFORT="
  printf '%s\n' "REALTIME_MODEL=gpt-live-1-boulder-alpha"
  printf '%s\n' "REALTIME_VOICE="
  printf '%s\n' "REALTIME_PROMPT="
  printf '%s\n' "CODEX_API_KEY="
  printf '%s\n' "CODEX_API_ENDPOINT="
  printf '%s\n' "CODEX_API_BASE_URL="
  printf '%s\n' "CODEX_HTTP_PROXY="
  printf '%s\n' "CODEX_HTTPS_PROXY="
  printf '%s\n' "CODEX_NO_PROXY=localhost,127.0.0.1,codex-app-server,voice-assistant"
  printf '%s\n' "CODEX_LOOPBACK_PROXY="
} > .env

mkdir -p data/certs
echo "Created .env for https://$codex_voice_ip:3000"
echo "Login password: $codex_voice_password"
echo "Workspace: $codex_voice_workspace"
echo "Edit .env before starting if either path is not what you want."
