#!/usr/bin/env bash
# One-time local Postgres setup for the website API.
# Creates database solana_agent_website and applies db/schema.sql.
#
# Prereq: Postgres installed locally (e.g. brew install postgresql@16 on macOS).
# Run from repo root or website/:  ./db/setup-local.sh   or   cd db && ./setup-local.sh
#
# Optional env: PGHOST, PGPORT, PGUSER (default: current user, port 5432).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
DB_NAME="solana_agent_website"

# Prefer Homebrew PostgreSQL if available (common on macOS)
if [ -d "/opt/homebrew/opt/postgresql@16/bin" ]; then
  export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
elif [ -d "/usr/local/opt/postgresql@16/bin" ]; then
  export PATH="/usr/local/opt/postgresql@16/bin:$PATH"
fi
if ! command -v psql &>/dev/null; then
  echo "psql not found. Install Postgres (e.g. macOS: brew install postgresql@16 && brew services start postgresql@16)."
  exit 1
fi

# Create database if it doesn't exist (ignore error if it already exists)
if psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  echo "Database $DB_NAME already exists."
else
  echo "Creating database $DB_NAME..."
  createdb "$DB_NAME" 2>/dev/null || psql -c "CREATE DATABASE $DB_NAME;" postgres 2>/dev/null || {
    echo "Could not create database. Try: createdb $DB_NAME   or   psql -c \"CREATE DATABASE $DB_NAME;\" postgres"
    exit 1
  }
fi

echo "Applying schema (schema.sql)..."
psql -d "$DB_NAME" -f schema.sql

echo "Done. Set in your .env when running the API locally:"
echo "  DATABASE_URL=postgresql://$(whoami)@localhost:5432/$DB_NAME"
echo "Or if you use a password: postgresql://user:password@localhost:5432/$DB_NAME"
