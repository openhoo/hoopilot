# syntax=docker/dockerfile:1

# hoopilot — OpenAI/Anthropic-compatible proxy for GitHub Copilot accounts.
# Multi-stage build on Bun: compile the TypeScript bundle once, then ship a
# small runtime image with only the production dependencies.
#
# Pinned to the same Bun version as package.json "packageManager".
ARG BUN_VERSION=1.3.14

# ---- Stage 1: build the dist/ bundle ---------------------------------------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# Install all dependencies (incl. devDeps: tsup, typescript) against the
# frozen lockfile for a reproducible build.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build dist/cli.js (+ index, codexx). tsup externalizes runtime deps
# (elysia, pino, pino-pretty); stage 2 installs them for the runtime image.
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- Stage 2: production-only dependencies ---------------------------------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Stage 3: runtime ------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

# OCI metadata. org.opencontainers.image.source links the GHCR package to this
# repository (the release workflow also injects these via docker/metadata-action).
LABEL org.opencontainers.image.source="https://github.com/openhoo/hoopilot" \
      org.opencontainers.image.description="OpenAI/Anthropic-compatible proxy for GitHub Copilot accounts" \
      org.opencontainers.image.licenses="MIT"

# Service defaults. HOST=0.0.0.0 is required so Docker port publishing can reach
# the proxy. Because the container cannot tell whether the published port is
# loopback-only, the image fails closed: hoopilot refuses to start on this
# non-loopback host unless HOOPILOT_API_KEY is set to a strong, unique secret
# of at least 24 characters.
# To intentionally run without authentication (e.g. behind your own auth proxy),
# set HOOPILOT_ALLOW_UNAUTHENTICATED=1.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4141 \
    HOOPILOT_LOG_FORMAT=json \
    HOOPILOT_LOG_LEVEL=info \
    HOOPILOT_NO_UPDATE_CHECK=1 \
    NO_UPDATE_NOTIFIER=1 \
    HOOPILOT_AUTH_FILE=/data/auth.json

WORKDIR /app

# Persisted OAuth credential store (written by `hoopilot login`).
# The base image ships a non-root `bun` user (uid/gid 1000).
RUN mkdir -p /data && chown -R bun:bun /data
VOLUME ["/data"]

COPY --chown=bun:bun --from=deps  /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/dist          ./dist
COPY --chown=bun:bun package.json ./

USER bun
EXPOSE 4141

# Liveness probe against /healthz, using Bun's fetch so the slim image needs
# no curl/wget. /healthz is behind the API-key gate, so send the key when set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "const k=process.env.HOOPILOT_API_KEY;fetch('http://127.0.0.1:'+(process.env.PORT||4141)+'/healthz',{headers:k?{'x-api-key':k}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "dist/cli.js"]
CMD ["serve"]
