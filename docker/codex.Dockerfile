FROM node:22.19.0-bookworm

ARG CODEX_VERSION=0.146.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bubblewrap jq ripgrep zsh \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY docker/codex-entrypoint.sh /usr/local/bin/codex-voice-entrypoint
RUN chmod 0755 /usr/local/bin/codex-voice-entrypoint

ENV HOME=/home/node
ENV CODEX_HOME=/home/node/.codex
WORKDIR /workspace
EXPOSE 4222
ENTRYPOINT ["codex-voice-entrypoint"]
