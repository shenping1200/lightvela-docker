#!/usr/bin/env bash
set -u
echo "===== UPDATE START $(date -u) ====="
DIR=$(find / -maxdepth 6 -type d -name "lightvela-docker" 2>/dev/null | head -1)
echo "DIR=$DIR"
if [ -z "$DIR" ]; then echo "NO_DIR_FOUND"; exit 2; fi
cd "$DIR" || exit 2
git stash push -m auto-update 2>/dev/null || true
git pull --ff-only origin main 2>&1 | tail -3
git stash pop 2>/dev/null || true
echo "HEAD=$(git rev-parse --short HEAD)"
docker compose up -d --build 2>&1 | tail -6
echo "HEALTH=$(docker inspect -f '{{.State.Health.Status}}' lightvela-web 2>/dev/null)"
echo "FINGER=$(docker compose exec lightvela-web grep -c buildFingerprint /app/lv_google_login.js 2>/dev/null)"
echo "GOOGLECORE=$(docker compose exec lightvela-web grep -c lv_google_login /app/lv_gui_core.py 2>/dev/null)"
echo "===== UPDATE END $(date -u) ====="
