#!/usr/bin/env bash
# =====================================================================
# POSTYAR — one-command local PREVIEW setup + run
# ---------------------------------------------------------------------
# Purpose: make the project previewable with a single command on any
# machine (sandbox preview panel, cPanel dev, local laptop):
#
#     bash scripts/preview-dev.sh
#
# What it does (idempotent, safe to re-run):
#   1. Creates .env from .env.example when missing, generating REAL
#      random dev secrets (master key / JWT / cron) via openssl.
#   2. Points DATABASE_URL at an ABSOLUTE, repo-local SQLite file
#      (db/postyar-preview.db). An absolute URL removes the classic
#      ambiguity where the Prisma CLI resolves `file:` URLs relative to
#      prisma/ while the runtime resolves them relative to cwd.
#   3. Applies every migration with `prisma migrate deploy` (never
#      `db push` — migrations are the source of truth, addendum P1.18).
#   4. Generates the Prisma client when node_modules exists.
#   5. Starts the dev server on 0.0.0.0:3000 (reverse-proxy friendly:
#      the preview gateway forwards Host/X-Forwarded-* headers).
#
# The real .env is NEVER committed (gitignored); only this script and
# the committed .env.example template are in the repository.
# =====================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
DB_FILE="$ROOT/db/postyar-preview.db"

mkdir -p "$ROOT/db"

if [ ! -f "$ENV_FILE" ]; then
  echo "[preview] .env not found — creating from .env.example with fresh dev secrets"
  cp .env.example "$ENV_FILE"
  if command -v openssl >/dev/null 2>&1; then
    MASTER_KEY="$(openssl rand -hex 32)"
    JWT_SECRET="$(openssl rand -hex 32)"
    CRON_SECRET="$(openssl rand -hex 32)"
  else
    MASTER_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    JWT_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    CRON_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  python3 - "$ENV_FILE" "$MASTER_KEY" "$JWT_SECRET" "$CRON_SECRET" <<'PYEOF'
import io, sys
path, master, jwt, cron = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = io.open(path, encoding="utf-8").read()
s = s.replace('POSTYAR_MASTER_KEY="REPLACE_WITH_64_HEX_CHARS"', f'POSTYAR_MASTER_KEY="{master}"')
s = s.replace('POSTYAR_JWT_SECRET="REPLACE_WITH_LONG_RANDOM_STRING"', f'POSTYAR_JWT_SECRET="{jwt}"')
s = s.replace('POSTYAR_CRON_SECRET="REPLACE_WITH_LONG_RANDOM_STRING"', f'POSTYAR_CRON_SECRET="{cron}"')
io.open(path, "w", encoding="utf-8").write(s)
PYEOF
  echo "[preview] secrets generated into .env (never commit it)"
fi

# Absolute SQLite URL wins over any inherited DATABASE_URL (the Prisma
# CLI resolves relative file: URLs from prisma/, the runtime from cwd —
# an absolute path keeps both processes on the SAME database).
export DATABASE_URL="file:${DB_FILE}"

echo "[preview] applying migrations to ${DB_FILE}"
bunx prisma migrate deploy

# Ensure the generated client matches the current schema.
bunx prisma generate >/dev/null

echo "[preview] starting POSTYAR on http://0.0.0.0:3000"
exec bunx next dev -p 3000 -H 0.0.0.0
