#!/usr/bin/env sh
# Exit 0 only if schema file contains no destructive SQL (DROP, TRUNCATE).
# Use before applying schema to the droplet to avoid accidental data loss.
# Usage: ./check-schema-safe.sh [schema.sql]
set -e
SCHEMA="${1:-$(dirname "$0")/schema.sql}"
if [ ! -f "$SCHEMA" ]; then
  echo "check-schema-safe: file not found: $SCHEMA"
  exit 1
fi
if grep -iE '^\s*(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\s+' "$SCHEMA" | grep -v '^\s*--' >/dev/null 2>&1; then
  echo "check-schema-safe: REFUSED: $SCHEMA contains DROP or TRUNCATE. Droplet DB must only receive additive DDL (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN)."
  exit 1
fi
# Also reject DELETE without WHERE (full table wipe)
if grep -iE '^\s*DELETE\s+FROM\s+\w+\s*;' "$SCHEMA" | grep -v '^\s*--' >/dev/null 2>&1; then
  echo "check-schema-safe: REFUSED: $SCHEMA contains DELETE FROM without WHERE."
  exit 1
fi
exit 0
