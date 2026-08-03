FROM node:22.19.0-bookworm

ARG CODEX_VERSION=0.146.0
ARG GH_VERSION=2.86.0
ARG TARGETARCH
RUN --mount=type=cache,id=codex-voice-gh-download,target=/var/cache/codex-voice-gh,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl git jq ripgrep zsh \
    && codex_voice_gh_arch="${TARGETARCH}" \
    && case "$codex_voice_gh_arch" in \
      amd64|arm64) ;; \
      *) echo "Unsupported architecture for GitHub CLI: $codex_voice_gh_arch" >&2; exit 1 ;; \
    esac \
    && codex_voice_gh_archive="gh_${GH_VERSION}_linux_${codex_voice_gh_arch}.tar.gz" \
    && codex_voice_gh_cache="/var/cache/codex-voice-gh" \
    && curl --fail --location --silent --show-error \
      --http1.1 --connect-timeout 30 --max-time 300 \
      --retry 10 --retry-delay 5 --retry-all-errors \
      --output "${codex_voice_gh_cache}/gh_${GH_VERSION}_checksums.txt" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
    && if ! (cd "$codex_voice_gh_cache" \
      && grep " ${codex_voice_gh_archive}$" "gh_${GH_VERSION}_checksums.txt" \
        | sha256sum --check --strict >/dev/null 2>&1); then \
      curl --fail --location --silent --show-error \
        --http1.1 --continue-at - --connect-timeout 30 --max-time 1800 \
        --retry 10 --retry-delay 5 --retry-all-errors \
        --output "${codex_voice_gh_cache}/${codex_voice_gh_archive}" \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${codex_voice_gh_archive}" \
      || { \
        rm -f "${codex_voice_gh_cache}/${codex_voice_gh_archive}"; \
        curl --fail --location --silent --show-error \
          --http1.1 --connect-timeout 30 --max-time 1800 \
          --retry 10 --retry-delay 5 --retry-all-errors \
          --output "${codex_voice_gh_cache}/${codex_voice_gh_archive}" \
          "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${codex_voice_gh_archive}"; \
      }; \
    fi \
    && cd "$codex_voice_gh_cache" \
    && grep " ${codex_voice_gh_archive}$" "gh_${GH_VERSION}_checksums.txt" | sha256sum --check --strict \
    && tar --extract --gzip --file "$codex_voice_gh_archive" --directory /tmp \
    && install --mode 0755 "/tmp/gh_${GH_VERSION}_linux_${codex_voice_gh_arch}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_${codex_voice_gh_arch}" \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY docker/codex-entrypoint.sh /usr/local/bin/codex-voice-entrypoint
RUN chmod 0755 /usr/local/bin/codex-voice-entrypoint

ENV HOME=/home/node
ENV CODEX_HOME=/home/node/.codex
ENV GIT_CONFIG_GLOBAL=/tmp/codex-voice-gitconfig
WORKDIR /workspace
EXPOSE 4222
ENTRYPOINT ["codex-voice-entrypoint"]
