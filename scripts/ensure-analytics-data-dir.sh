#!/usr/bin/env bash
# Ensure visitor analytics can append to data/site-visitors.jsonl (api-server.cjs).
# Deploy runs this so POST /api/analytics/pageview does not return ANALYTICS_WRITE_FAILED.
# Usage: bash scripts/ensure-analytics-data-dir.sh [/var/www/solana_agent]
set -e
ROOT="${1:-/var/www/solana_agent}"
DATA_DIR="$ROOT/data"
mkdir -p "$DATA_DIR"

US=""
if command -v systemctl >/dev/null 2>&1; then
  US="$(systemctl show solana-agent-website-api -p User --value 2>/dev/null | head -1 || true)"
fi
US="${US:-root}"
if id "$US" &>/dev/null 2>&1; then
  chown "$US:$US" "$DATA_DIR" || true
fi
# World-writable: only this subdirectory; avoids 500s when systemd User= does not match site file owner.
chmod a+rwx "$DATA_DIR" || chmod 777 "$DATA_DIR" || true
