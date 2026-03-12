# syntax=docker/dockerfile:1
# Keyoku E2E Test — OpenClaw + Keyoku plugin (NO pre-registration)
# Tests: keyoku init inside the container, then starts gateway for e2e
#
# Self-contained: downloads pre-built keyoku-engine binary from GitHub releases.
# No dependency on keyoku-engine source checkout.

# Stage 1: Build Keyoku TypeScript plugin
FROM node:22-bookworm AS plugin-builder
WORKDIR /keyoku
COPY package.json tsconfig.json ./
COPY packages ./packages
RUN npm install --ignore-scripts && npm run build

# Stage 2: Final image — OpenClaw + Keyoku (but NOT registered)
FROM ghcr.io/openclaw/openclaw:2026.3.8

USER root

# Install curl for health checks + python3 for assertions
RUN apt-get update -qq && apt-get install -y -qq curl python3 && rm -rf /var/lib/apt/lists/*

# Download pre-built keyoku binary from GitHub releases
ARG KEYOKU_VERSION=v0.2.1
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    OS="linux" && \
    URL="https://github.com/Keyoku-ai/keyoku-engine/releases/download/${KEYOKU_VERSION}/keyoku-server-${OS}-${ARCH}" && \
    echo "Downloading keyoku from $URL" && \
    curl -fsSL "$URL" -o /usr/local/bin/keyoku && \
    chmod +x /usr/local/bin/keyoku

# Also install to ~/.keyoku/bin/ so init detects it without downloading
RUN mkdir -p /home/node/.keyoku/bin \
    && cp /usr/local/bin/keyoku /home/node/.keyoku/bin/keyoku \
    && chown -R node:node /home/node/.keyoku

# Create keyoku data directory
RUN mkdir -p /data && chown node:node /data

# Install keyoku-memory plugin files (so OpenClaw can load it AFTER init registers it)
RUN mkdir -p /app/extensions/keyoku-memory/dist /app/extensions/keyoku-memory/node_modules/@keyoku \
    && chown -R node:node /app/extensions/keyoku-memory

COPY --from=plugin-builder --chown=node:node /keyoku/packages/types/dist/ /app/extensions/keyoku-memory/dist/types/
COPY --from=plugin-builder --chown=node:node /keyoku/packages/memory/dist/ /app/extensions/keyoku-memory/dist/memory/
COPY --from=plugin-builder --chown=node:node /keyoku/packages/openclaw/dist/ /app/extensions/keyoku-memory/dist/openclaw/

RUN ln -s ../../dist/types /app/extensions/keyoku-memory/node_modules/@keyoku/types \
    && ln -s ../../dist/memory /app/extensions/keyoku-memory/node_modules/@keyoku/memory

COPY --from=plugin-builder --chown=node:node /keyoku/node_modules/@sinclair /app/extensions/keyoku-memory/node_modules/@sinclair

COPY --chown=node:node tests/e2e/openclaw.plugin.json /app/extensions/keyoku-memory/openclaw.plugin.json

RUN cat > /app/extensions/keyoku-memory/index.js << 'ENTRY'
import keyokuMemory from './dist/openclaw/index.js';
const plugin = keyokuMemory();
export default plugin;
ENTRY

RUN cat > /app/extensions/keyoku-memory/package.json << 'PKG'
{
  "name": "keyoku-memory",
  "version": "2.0.0",
  "openclaw": { "extensions": ["index.js"] }
}
PKG

RUN chown -R node:node /app/extensions/keyoku-memory

# Install init CLI so it can run inside container
COPY --from=plugin-builder --chown=node:node /keyoku/packages/openclaw/dist/ /opt/keyoku-init/dist/
COPY --from=plugin-builder --chown=node:node /keyoku/packages/openclaw/bin/ /opt/keyoku-init/bin/
COPY --from=plugin-builder --chown=node:node /keyoku/packages/openclaw/package.json /opt/keyoku-init/package.json
COPY --from=plugin-builder --chown=node:node /keyoku/packages/types/dist/ /opt/keyoku-init/node_modules/@keyoku/types/
COPY --from=plugin-builder --chown=node:node /keyoku/packages/memory/dist/ /opt/keyoku-init/node_modules/@keyoku/memory/

# OpenClaw config — CLEAN, no plugins section
RUN mkdir -p /home/node/.openclaw/workspace/memory \
    && chown -R node:node /home/node/.openclaw
COPY --chown=node:node tests/e2e/openclaw.json /home/node/.openclaw/openclaw.json
COPY --chown=node:node tests/e2e/openclaw.json /home/node/.openclaw/openclaw.json.clean

# Bake workspace test data into image (MEMORY.md, memory/, HEARTBEAT.md)
COPY --chown=node:node tests/e2e/workspace/ /home/node/.openclaw/workspace/

# Copy test entrypoint
COPY --chown=node:node tests/e2e/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Environment defaults
ENV KEYOKU_DB_PATH=/data/keyoku.db
ENV KEYOKU_SESSION_TOKEN=test-token
ENV KEYOKU_PORT=18900
ENV HOME=/home/node

USER node

EXPOSE 18789

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["full-test"]
