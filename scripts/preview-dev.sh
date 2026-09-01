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
#   1. Creates the EXPLICIT preview environment file `.env.preview` from
#      `.env.example` when missing, generating REAL random dev secrets
#      (master key / JWT / cron) via openssl.
#      V4 M-11 — the preview NEVER silently consumes a production `.env`:
#        * every key defined in `.env.preview` is exported into the
#          server process BEFORE `next dev` starts, and process-env
#          always wins over Next.js `.env` files;
#        * every SECURITY-RELEVANT provider key (SMS / SMTP / bank
#          gateways / gold / AI / Redis / public URL) is explicitly set
#          to its sandbox value (empty or "mock"), so a production
#          `.env` sitting next to the repo can never leak real
#          credentials or real destinations into the preview;
#        * the real `.env` is NEVER read, written or overwritten.
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
# Side-effect safety (V4 M-10 + V5 H-17/H-18): with the sandbox env below,
# the SMS and bank channels are hard-disabled in non-production runtime
# (NODE_ENV=development), so the preview can NEVER send a real SMS or
# e-mail, and the bank gateway channels refuse to run outside production.
# ONE DOCUMENTED EXCEPTION: the Bale wallet-invoice path (sendInvoice →
# pre_checkout_query → successful_payment) is DB-token gated — it fires
# ONLY if the operator deliberately configures a REAL bot token inside the
# preview UI (the preview env itself ships every bot/sms/bank credential
# empty). Telegram/Bale/Rubika bots never talk to any API until such a
# token is entered by the user INSIDE the preview UI.
#
# `.env.preview` is gitignored and must never be committed; only this
# script and the committed `.env.example` template are in the repository.
# =====================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.preview"
DB_FILE="$ROOT/db/postyar-preview.db"

mkdir -p "$ROOT/db"

if [ -f "$ROOT/.env" ]; then
  echo "[preview] WARNING: a production '.env' exists next to the repo."
  echo "[preview] The preview will NOT read it: every security-relevant"
  echo "[preview] variable is explicitly overridden from '.env.preview'."
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "[preview] .env.preview not found — creating from .env.example with fresh dev secrets"
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
  echo "[preview] secrets generated into .env.preview (never commit it)"
fi

# ---------------------------------------------------------------------
# V4 M-11 — export the preview environment. `set -a` exports every
# variable defined in .env.preview, and process-env wins over any .env
# file Next.js would otherwise load, so a production .env can NEVER
# silently leak values into the preview runtime.
# ---------------------------------------------------------------------
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# V4 M-10/M-11 — SANDBOX OVERRIDES: explicitly neutralize every channel
# with a real-world side effect. These win over BOTH .env.preview and any
# production .env, so the preview is side-effect-safe by construction.
export NODE_ENV=development
export DATABASE_URL="file:${DB_FILE}?socket_timeout=30000&busy_timeout=30000"
export POSTYAR_SMS_PROVIDER=""
export POSTYAR_SMS_API_KEY=""
export POSTYAR_SMS_USERNAME=""
export POSTYAR_SMS_PASSWORD=""
export POSTYAR_SMS_SENDER=""
export POSTYAR_SMTP_HOST=""
export POSTYAR_SMTP_USER=""
export POSTYAR_SMTP_PASSWORD=""
export POSTYAR_BANK_DIRECT_URL=""
export POSTYAR_BANK_DIRECT_MERCHANT=""
export POSTYAR_BANK_DIRECT_TERMINAL=""
export POSTYAR_BANK_DIRECT_SECRET=""
export POSTYAR_BANK_INTERMEDIARY_URL=""
export POSTYAR_BANK_INTERMEDIARY_MERCHANT=""
export POSTYAR_BANK_INTERMEDIARY_SECRET=""
export POSTYAR_GOLD_PROVIDER_URL=""
export POSTYAR_AI_PROVIDER=""
export POSTYAR_AI_API_KEY=""
export REDIS_URL=""
# V5 H-17 — POSTYAR_PUBLIC_BASE_URL is forced EMPTY: a value inherited from
# the shell or a placeholder copied from .env.example
# (https://postyar.example.com) would make webhook registration point a
# REAL bot at a dead public URL instead of the documented localhost
# fallback + poll route. Empty here ⇒ getPublicBaseUrl() degrades to the
# dev fallback (http://localhost:3000) and the cron poll route.
export POSTYAR_PUBLIC_BASE_URL=""
# V5 H-18 — the dev-suppression overrides must be forced EMPTY: a shell-
# inherited POSTYAR_ALLOW_REAL_SMS_IN_DEV=1 / POSTYAR_ALLOW_REAL_BANK_IN_DEV=1
# would otherwise DEFEAT the dev guards in src/lib/providers/sms and
# src/lib/payments/bank and let the preview reach real providers.
export POSTYAR_ALLOW_REAL_SMS_IN_DEV=""
export POSTYAR_ALLOW_REAL_BANK_IN_DEV=""
# V5 H-18 — a shipped/inherited Ollama URL makes local Ollama look
# "available" in the preview provider list; force it empty so only
# postyar-zai (in-house, no external side effect) is offered.
export POSTYAR_AI_OLLAMA_URL=""
# V5 H-18 — per-provider AI keys (POSTYAR_AI_OPENAI_KEY, POSTYAR_AI_GEMINI_KEY,
# …): an inherited REAL key would flow into real billable provider calls.
# Unset EVERY POSTYAR_AI_*_KEY from the environment (pure-bash loop — no
# grep -P dependency). The generic POSTYAR_AI_API_KEY is re-emptied right
# after the loop, since it matches the *_KEY glob.
while IFS='=' read -r _k _v; do
  case "${_k}" in
    POSTYAR_AI_*_KEY) unset "${_k}" ;;
  esac
done < <(env)
export POSTYAR_AI_API_KEY=""
# NOTE: operators who deliberately want a real AI provider in the preview
# must edit .env.preview AND this block — the default is fail-closed.

echo "[preview] applying migrations to ${DB_FILE}"
bunx prisma migrate deploy

# Ensure the generated client matches the current schema.
bunx prisma generate >/dev/null

echo "[preview] starting POSTYAR on http://0.0.0.0:3000 (sandbox env: no real SMS/bank/email)"
exec bunx next dev -p 3000 -H 0.0.0.0
