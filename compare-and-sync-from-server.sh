#!/usr/bin/env bash
# Compare local website/ files with server (source of truth) and optionally pull from server.
# Requires: .env with DROPLET_IP and DROPLET_SSH_PASSWORD (same as deploy-website-to-droplet.sh).
#
# Compare only (no changes):
#   ./compare-and-sync-from-server.sh
# Pull from server → local (overwrite local with server files):
#   PULL=1 ./compare-and-sync-from-server.sh

set -e
cd "$(dirname "$0")"

# Load .env from this dir or parent (e.g. repo root)
ENV_FILE=""
if [ -f .env ]; then
  ENV_FILE=".env"
elif [ -f ../.env ]; then
  ENV_FILE="../.env"
fi
if [ -z "$ENV_FILE" ]; then
  echo "Missing .env. Add DROPLET_IP and DROPLET_SSH_PASSWORD in .env in this directory or the parent."
  exit 1
fi

set -a
source "$ENV_FILE"
set +a
: "${DROPLET_IP:?Set DROPLET_IP in .env}"
: "${DROPLET_SSH_PASSWORD:?Set DROPLET_SSH_PASSWORD in .env}"

REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_DIR="/var/www/solana_agent"
PULL="${PULL:-0}"
REMOTE_LIST=$(mktemp)
LOCAL_LIST=$(mktemp)
trap 'rm -f "$REMOTE_LIST" "$LOCAL_LIST" .remote_list.txt' EXIT

echo "Comparing with $REMOTE_USER@$DROPLET_IP ($REMOTE_DIR) (server = source of truth)..."
echo ""

# 1. Get remote file list: only under REMOTE_DIR, exclude node_modules. Create file on server, then scp it down.
#    Remote command uses RD variable so path is correct on server; output is relative paths only.
export DROPLET_IP DROPLET_SSH_PASSWORD REMOTE_USER REMOTE_DIR SCRIPT_DIR="$PWD"
REMOTE_FIND_CMD="RD='$REMOTE_DIR'; find \"\$RD\" -type f ! -path \"\$RD/node_modules/*\" ! -path \"\$RD/.git/*\" -exec stat --printf='%s %n\\n' {} \\; 2>/dev/null | sed \"s| \$RD/| |g;s| \$RD\\\$||\" > /tmp/solana_agent_remote_list.txt"
export REMOTE_FIND_CMD
expect << 'EXPECT_FETCH'
set timeout 30
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP) $env(REMOTE_FIND_CMD)
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof
EXPECT_FETCH

expect << 'EXPECT_SCP'
set timeout 30
spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP):/tmp/solana_agent_remote_list.txt $env(SCRIPT_DIR)/.remote_list.txt
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof
EXPECT_SCP

if [ -f ".remote_list.txt" ] && [ -s ".remote_list.txt" ]; then
  sed 's|^[[:space:]]*||;s|[[:space:]]*$||' .remote_list.txt | grep -v '^$' | sort -k 2 > "$REMOTE_LIST"
else
  echo "Could not fetch remote file list (check SSH and .env). Creating empty list."
  : > "$REMOTE_LIST"
fi

# 2. Build local list (size path), no node_modules
while IFS= read -r -d '' path; do
  rel="${path#./}"
  [ -z "$rel" ] && continue
  size=$(stat -f %z "$path" 2>/dev/null || stat -c %s "$path" 2>/dev/null)
  printf '%s %s\n' "$size" "$rel"
done < <(find . -type f ! -path './node_modules/*' ! -path './.git/*' ! -name '.remote_list.txt' -print0 2>/dev/null) | sort -k 2 > "$LOCAL_LIST"

echo "--- Files on server (source of truth) ---"
while read -r size path; do [ -n "$path" ] && echo "  $size $path"; done < "$REMOTE_LIST"
echo ""

echo "--- Files locally ---"
while read -r size path; do [ -n "$path" ] && echo "  $size $path"; done < "$LOCAL_LIST"
echo ""

echo "--- Only on server (not in local) ---"
comm -23 <(awk '{print $2}' "$REMOTE_LIST" | sort -u) <(awk '{print $2}' "$LOCAL_LIST" | sort -u 2>/dev/null) | while read -r p; do
  [ -n "$p" ] && echo "  $p"
done
echo ""

echo "--- Only local (not on server) ---"
comm -13 <(awk '{print $2}' "$REMOTE_LIST" | sort -u) <(awk '{print $2}' "$LOCAL_LIST" | sort -u 2>/dev/null) | while read -r p; do
  [ -n "$p" ] && echo "  $p"
done
echo ""

echo "--- Size differences (same path, different size) ---"
comm -12 <(awk '{print $2}' "$REMOTE_LIST" | sort -u) <(awk '{print $2}' "$LOCAL_LIST" | sort -u 2>/dev/null) | while read -r path; do
  [ -z "$path" ] && continue
  local_size=$(awk -v p="$path" '$2==p {print $1; exit}' "$LOCAL_LIST")
  remote_size=$(awk -v p="$path" '$2==p {print $1; exit}' "$REMOTE_LIST")
  if [ -n "$local_size" ] && [ -n "$remote_size" ] && [ "$local_size" != "$remote_size" ]; then
    echo "  $path: local=$local_size server=$remote_size"
  fi
done
echo ""

if [ "$PULL" = "1" ]; then
  # Only pull files under /var/www/solana_agent that are in the allowlist (same set deploy script uses).
  # This prevents accidentally pulling anything outside the website directory.
  ALLOWLIST="index.html asry.html reserves-bitcoin.html reserves-absr.html reserves-solana.html reserves-declaration.html proof-of-reserves.html api.html clawstr.html solanaagent_rec.png loading-animation.gif icon_dock.png icon_asry_nb.png icon_absr_nb.png logo_btc_nb.png SOL.png USDC.png USDT.png api-server.cjs openapi.json package.json package-lock.json mint-absr-to-reserve.cjs run-daily-absr-mint.sh test-lifi-sol-to-btc.js"
  echo "PULL=1: Pulling from $REMOTE_DIR only (allowlist: website files + clawstr/)..."
  pulled=0
  while read -r size path; do
    [ -z "$path" ] && continue
    # Reject absolute paths or paths containing ..
    case "$path" in
      /*|*..*) continue ;;
    esac
    # Only pull if in allowlist or under clawstr/
    case " $ALLOWLIST " in
      *" $path "*) ;;
      *)
        case "$path" in clawstr/*) ;; *)
          echo "  skip (not in allowlist): $path"
          continue
          ;;
        esac
        ;;
    esac
    dir=$(dirname "$path")
    mkdir -p "$dir"
    export REMOTE_USER DROPLET_IP REMOTE_DIR DROPLET_SSH_PASSWORD
    export PULL_PATH="$path"
    expect << 'EXPECT_PULL'
set timeout 60
spawn scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 $env(REMOTE_USER)@$env(DROPLET_IP):$env(REMOTE_DIR)/$env(PULL_PATH) $env(PULL_PATH)
expect "password:"
send "$env(DROPLET_SSH_PASSWORD)\r"
expect eof
EXPECT_PULL
    echo "  pulled: $path"
    pulled=$((pulled + 1))
  done < "$REMOTE_LIST"
  echo "Done. Pulled $pulled file(s) from $REMOTE_DIR (source of truth)."
else
  echo "To overwrite local with server files (allowlist only), run: PULL=1 $0"
fi
