# Build stage - compile all binaries
FROM oven/bun:1 AS builder
WORKDIR /build

# Install deps first (cache layer)
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock ./web/
RUN bun install --frozen-lockfile && cd web && bun install --frozen-lockfile

# Copy source
COPY . .

# Build everything
RUN bun run build

# Runtime stage - minimal image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled binaries + web assets
COPY --from=builder /build/bin/concentrator /usr/local/bin/concentrator
COPY --from=builder /build/bin/concentrator-cli /usr/local/bin/concentrator-cli
COPY --from=builder /build/web/dist /srv/web

# Data directories
RUN mkdir -p /data/cache /data/transcripts

EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:9999/health || exit 1

ENTRYPOINT ["concentrator"]
CMD ["--web-dir", "/srv/web", "--cache-dir", "/data/cache", "--allow-root", "/data/transcripts"]
