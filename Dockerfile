# Build stage - compile all binaries
FROM oven/bun:1 AS builder
WORKDIR /build

# Build args used by gen-version.ts (which has no git inside the container).
# These flow in from scripts/docker-build-broker.sh via --build-arg.
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_SHORT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_COMMIT_SHORT=${GIT_COMMIT_SHORT}
ENV BUILD_TIME=${BUILD_TIME}

# Install deps first (cache layer)
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock ./web/
RUN bun install --frozen-lockfile && cd web && bun install --frozen-lockfile

# Copy source. When built via scripts/docker-build-broker.sh this is `git archive
# HEAD` piped on stdin, so no host working-tree state can leak in. Direct
# `docker build .` invocations are deliberately discouraged (see docker-compose.yml).
COPY . .

# Build server binaries only (web is built locally and volume-mounted).
# build:broker's dirty-tree check no-ops here because .git is not in the context.
RUN bun run gen-version && bun run build:broker && bun run build:cli

# Runtime stage - minimal image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled binaries
COPY --from=builder /build/bin/broker /usr/local/bin/broker
COPY --from=builder /build/bin/broker-cli /usr/local/bin/broker-cli

# Copy pre-built web assets (built locally with Vite 8, volume-mounted in production)
COPY web/dist /srv/web

# Data directories
RUN mkdir -p /data/cache /data/transcripts

# Build provenance: commit SHA the broker binary was built from.
# Supplied by scripts/docker-build-broker.sh via --build-arg.
# Inspect with: docker inspect broker --format '{{.Config.Labels.commit}}'
# Or from inside: docker exec broker printenv GIT_COMMIT
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_SHORT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_COMMIT_SHORT=${GIT_COMMIT_SHORT}
ENV BUILD_TIME=${BUILD_TIME}
LABEL commit=${GIT_COMMIT}
LABEL commit_short=${GIT_COMMIT_SHORT}
LABEL build_time=${BUILD_TIME}
LABEL org.opencontainers.image.revision=${GIT_COMMIT}
LABEL org.opencontainers.image.created=${BUILD_TIME}

EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:9999/health || exit 1

ENTRYPOINT ["broker"]
CMD ["--web-dir", "/srv/web", "--cache-dir", "/data/cache", "--allow-root", "/data/transcripts"]
