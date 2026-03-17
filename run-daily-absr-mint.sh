#!/usr/bin/env bash
# Run the daily ABSR reserve sync: compare BTC reserve balance to ABSR supply and mint any shortfall.
# Source env from secrets file (droplet) or .env (local), then run mint-absr-to-reserve.cjs.
# Schedule with cron (e.g. 0 2 * * *) or systemd timer (see jobs/README.md or db/README.md).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# On droplet: use secrets file. Locally or override: use SECRETS_FILE or .env
if [ -n "$SECRETS_FILE" ] && [ -f "$SECRETS_FILE" ]; then
  set -a
  source "$SECRETS_FILE"
  set +a
elif [ -f /etc/solana-agent-website/secrets ]; then
  set -a
  source /etc/solana-agent-website/secrets
  set +a
elif [ -f .env ]; then
  set -a
  source .env
  set +a
elif [ -f ../.env ]; then
  set -a
  source ../.env
  set +a
else
  echo "run-daily-absr-mint: No env found. Set SECRETS_FILE or place .env in website/ or parent."
  exit 1
fi

exec node "$SCRIPT_DIR/mint-absr-to-reserve.cjs"
