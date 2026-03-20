#!/usr/bin/env bash
# Restart the API on the droplet. Uses same .env as deploy-website-to-droplet.sh (DROPLET_IP, DROPLET_SSH_PASSWORD).
# Run from website directory: ./restart-droplet-api.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=""
[ -f .env ] && ENV_FILE=".env"
[ -z "$ENV_FILE" ] && [ -f ../.env ] && ENV_FILE="../.env"
if [ -z "$ENV_FILE" ]; then
  echo "Missing .env. Add DROPLET_IP and DROPLET_SSH_PASSWORD."
  exit 1
fi

set -a
source "$ENV_FILE"
set +a
: "${DROPLET_IP:?Set DROPLET_IP in .env}"
: "${DROPLET_SSH_PASSWORD:?Set DROPLET_SSH_PASSWORD in .env}"

REMOTE_USER="${REMOTE_USER:-root}"

export DROPLET_IP DROPLET_SSH_PASSWORD REMOTE_USER

expect << 'EXPECT_SCRIPT'
set timeout 30
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP) "systemctl restart solana-agent-website-api 2>/dev/null || systemctl restart solana-agent-website 2>/dev/null || systemctl restart solana_agent_website 2>/dev/null || (pkill -f 'node.*api-server.cjs' 2>/dev/null; sleep 1; cd /var/www/solana_agent && nohup node api-server.cjs >> /var/log/solana-api.log 2>&1 &); echo RESTART_DONE"
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof
EXPECT_SCRIPT

echo "Restart sent. Check https://www.solanaagent.app/api/reserves or /api/asry-info"
