#!/usr/bin/env bash
# Deploy or update website/ to droplet in /var/www/solana_agent.
# Run from the website directory (where this script lives). Requires .env here or in parent.
# Requires: .env with DROPLET_IP, DROPLET_SSH_PASSWORD; optional CERTBOT_EMAIL for Let's Encrypt.
#
# Update only (site already set up):  ./deploy-website-to-droplet.sh
#   or:  UPDATE_ONLY=1 ./deploy-website-to-droplet.sh
# Full setup (nginx + SSL):          UPDATE_ONLY=0 ./deploy-website-to-droplet.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# .env in this dir or parent (e.g. repo root)
ENV_FILE=""
if [ -f .env ]; then
  ENV_FILE=".env"
elif [ -f ../.env ]; then
  ENV_FILE="../.env"
fi
if [ -z "$ENV_FILE" ]; then
  echo "Missing .env. Add DROPLET_IP and DROPLET_SSH_PASSWORD (and optionally CERTBOT_EMAIL) in .env in this directory or the parent."
  exit 1
fi

set -a
source "$ENV_FILE"
set +a
: "${DROPLET_IP:?Set DROPLET_IP in .env}"
: "${DROPLET_SSH_PASSWORD:?Set DROPLET_SSH_PASSWORD in .env}"
export CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_DIR="/var/www/solana_agent"
CONTENT_DIR="$SCRIPT_DIR"
UPDATE_ONLY="${UPDATE_ONLY:-1}"

# Deploy files (nginx, patch) live in agent/deploy/ when run from website/
# (Do not use failing cd in $(...) with set -e — script would exit with no message.)
DEPLOY_DIR=""
if [ -f "$SCRIPT_DIR/../agent/deploy/nginx-api-location.conf" ]; then
  DEPLOY_DIR="$(cd "$SCRIPT_DIR/../agent/deploy" && pwd)"
fi
if [ -z "$DEPLOY_DIR" ]; then
  if [ "$UPDATE_ONLY" = "0" ]; then
    echo "Note: agent/deploy/ not found (run from repo with website/ and agent/). Nginx/SSL setup will be skipped."
  else
    echo "Note: agent/deploy/ not found. Nginx patch step will be skipped."
  fi
fi

echo "Deploying to $REMOTE_USER@$DROPLET_IP ($REMOTE_DIR)${UPDATE_ONLY:+ (update only)}..."

# Use expect to drive ssh/scp with password
export DROPLET_IP DROPLET_SSH_PASSWORD REMOTE_USER REMOTE_DIR CONTENT_DIR DEPLOY_DIR
export CERTBOT_EMAIL UPDATE_ONLY
export SCRIPT_DIR

expect << 'EXPECT_SCRIPT'
set timeout 120

# 1. Create remote dir (including db for schema)
spawn ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP) "mkdir -p $env(REMOTE_DIR)/db"
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof

# 2. SCP website files (static + API server)
spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(CONTENT_DIR)/index.html $env(CONTENT_DIR)/asry.html $env(CONTENT_DIR)/reserves-bitcoin.html $env(CONTENT_DIR)/reserves-absr.html $env(CONTENT_DIR)/reserves-solana.html $env(CONTENT_DIR)/reserves-declaration.html $env(CONTENT_DIR)/proof-of-reserves.html $env(CONTENT_DIR)/api.html $env(CONTENT_DIR)/solanaagent_rec.png $env(CONTENT_DIR)/loading-animation.gif $env(CONTENT_DIR)/icon_dock.png $env(CONTENT_DIR)/icon_asry_nb.png $env(CONTENT_DIR)/icon_absr_nb.png $env(CONTENT_DIR)/logo_btc_nb.png $env(CONTENT_DIR)/api-server.cjs $env(CONTENT_DIR)/openapi.json $env(CONTENT_DIR)/package.json $env(CONTENT_DIR)/mint-absr-to-reserve.cjs $env(CONTENT_DIR)/run-daily-absr-mint.sh $env(CONTENT_DIR)/test-lifi-sol-to-btc.js $env(REMOTE_USER)@$env(DROPLET_IP):$env(REMOTE_DIR)/
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof

spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(CONTENT_DIR)/db/schema.sql $env(REMOTE_USER)@$env(DROPLET_IP):$env(REMOTE_DIR)/db/
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof

# 3. If update only: patch nginx to add /api/ proxy if missing, then reload (requires DEPLOY_DIR)
if { $env(UPDATE_ONLY) == "1" } {
  if { [string length $env(DEPLOY_DIR)] > 0 } {
    spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(DEPLOY_DIR)/nginx-api-location.conf $env(DEPLOY_DIR)/patch-nginx-api.cjs $env(REMOTE_USER)@$env(DROPLET_IP):/root/
    expect "password:"
    send "$env(DROPLET_SSH_PASSWORD)\r"
    expect eof

    spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP) "cd /root && node patch-nginx-api.cjs /etc/nginx/sites-available/solanaagent.app 2>/dev/null; nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null; true"
    expect "password:"
    send "$env(DROPLET_SSH_PASSWORD)\r"
    expect eof
  }
} else {
  # Full setup: SCP nginx config and setup script (requires DEPLOY_DIR)
  if { [string length $env(DEPLOY_DIR)] > 0 } {
    spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(DEPLOY_DIR)/website-nginx.conf $env(REMOTE_USER)@$env(DROPLET_IP):/root/solana_agent_nginx.conf
    expect "password:"
    send "$env(DROPLET_SSH_PASSWORD)\r"
    expect eof

    spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(DEPLOY_DIR)/website-droplet-setup.sh $env(REMOTE_USER)@$env(DROPLET_IP):/root/website-droplet-setup.sh
    expect "password:"
    send "$env(DROPLET_SSH_PASSWORD)\r"
    expect eof

    spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP) "chmod +x /root/website-droplet-setup.sh && CERTBOT_EMAIL=$env(CERTBOT_EMAIL) /root/website-droplet-setup.sh"
    expect "password:"
    send "$env(DROPLET_SSH_PASSWORD)\r"
    expect eof
  }
}
EXPECT_SCRIPT

echo "Deploy complete. Visit https://www.solanaagent.app"
