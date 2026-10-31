#!/usr/bin/env bash
# Pull the latest code and restart only what changed.
# Run on the server:  cd ~/EcoPulse/deploy/oracle && ./update.sh
set -euo pipefail
cd "$(dirname "$0")"

git -C ../.. pull --ff-only
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
