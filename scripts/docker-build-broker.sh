#!/usr/bin/env bash
# Build the broker Docker image from `git archive HEAD`, NOT the host working tree.
#
# This is the only sanctioned way to build the broker image. The build context
# is a tarball produced by git, so uncommitted modifications, untracked files,
# and stashed work CANNOT leak into the image by construction.
#
# Refuses to build if the working tree is dirty (overridable with --force-dirty
# for emergencies, e.g. hotfix you haven't committed yet -- but commit first).
#
# Usage:
#   scripts/docker-build-broker.sh                 # tag :latest and :<shortsha>
#   scripts/docker-build-broker.sh --force-dirty   # override dirty refusal
#   IMAGE=foo scripts/docker-build-broker.sh       # override image name

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

IMAGE="${IMAGE:-remote-claude-broker}"
FORCE_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --force-dirty) FORCE_DIRTY=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[docker-build] FATAL: not in a git repo. Refusing to build (no commit to anchor to)." >&2
  exit 1
fi

COMMIT=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Dirty check.
PORCELAIN=$(git status --porcelain | grep -v 'src/shared/version.ts' || true)
if [[ -n "$PORCELAIN" ]]; then
  echo "" >&2
  echo "[docker-build] Working tree is dirty. The following will NOT be in the image:" >&2
  echo "  HEAD = $SHORT -- this is the commit the image will reflect." >&2
  echo "$PORCELAIN" | sed 's/^/    /' >&2
  if [[ "$FORCE_DIRTY" -ne 1 ]]; then
    echo "" >&2
    echo "  Commit your work first:  git add -A && git commit -m 'wip'" >&2
    echo "  Or override (emergency only):  $0 --force-dirty" >&2
    echo "" >&2
    exit 1
  fi
  echo "" >&2
  echo "  --force-dirty was passed. Proceeding." >&2
  echo "  WARNING: image tag :$SHORT will NOT match commit $SHORT." >&2
  echo "" >&2
  SHORT="${SHORT}-dirty"
fi

# Make sure web/dist exists for the COPY in Dockerfile. (Web bundle is
# volume-mounted in prod but the Dockerfile still copies it for offline
# fallback.) Build it locally so the image carries a reasonable default.
if [[ ! -d "web/dist" ]] || [[ -z "$(ls -A web/dist 2>/dev/null)" ]]; then
  echo "[docker-build] web/dist is missing/empty. Running 'bun run build:web'..." >&2
  bun run build:web
fi

echo "[docker-build] commit=$SHORT ($COMMIT)"
echo "[docker-build] building image $IMAGE:latest and $IMAGE:$SHORT"

# git archive HEAD produces a tarball of the tree at HEAD. We splice web/dist
# (gitignored, built locally) into the tarball so the Dockerfile's COPY web/dist
# still works.
TAR=$(mktemp -t docker-build-broker.XXXXXX.tar)
trap 'rm -f "$TAR"' EXIT

git archive --format=tar -o "$TAR" HEAD
# Append the locally-built web/dist (not in git, but needed for COPY web/dist
# in the Dockerfile -- which is the offline-fallback copy, the prod volume mount
# overrides it).
tar --append -f "$TAR" web/dist

docker build \
  --build-arg GIT_COMMIT="$COMMIT" \
  --build-arg GIT_COMMIT_SHORT="$SHORT" \
  --build-arg BUILD_TIME="$BUILD_TIME" \
  -t "$IMAGE:latest" \
  -t "$IMAGE:$SHORT" \
  -f Dockerfile - < "$TAR"

echo ""
echo "[docker-build] done"
echo "  image: $IMAGE:latest"
echo "  image: $IMAGE:$SHORT"
echo "  commit: $COMMIT"
echo ""
echo "  Inspect: docker inspect $IMAGE:latest --format '{{.Config.Labels.commit}}'"
echo "  Run:     docker compose up -d   (no --build flag needed)"
