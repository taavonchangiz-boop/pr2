# POSTYAR — Preview Guide

## One-command preview

```bash
bash scripts/preview-dev.sh
```

The script is idempotent and safe to re-run. It:

1. creates the **explicit preview environment file** `.env.preview` from `.env.example` (with freshly generated dev secrets) when missing. The preview **never silently consumes a production `.env`**: every key from `.env.preview` is exported into the process (process-env wins over Next `.env` files), and every security-relevant channel (SMS, SMTP, bank gateways, gold, AI, Redis) is explicitly neutralized to its sandbox value. The real `.env` is never read, written or overwritten;
2. points `DATABASE_URL` at an **absolute, repo-local** SQLite file (`db/postyar-preview.db`) — an absolute URL is required because the Prisma CLI resolves relative `file:` URLs from `prisma/` while the runtime resolves them from the process cwd, which silently splits the two onto different databases;
3. applies **all migrations** with `prisma migrate deploy` (never `db push`);
4. generates the Prisma client;
5. serves on `0.0.0.0:3000` (reverse-proxy friendly — the preview gateway forwards `Host`/`X-Forwarded-*`).

## Side-effect safety (preview never touches real providers)

The preview runs with `NODE_ENV=development` and empty sandbox credentials,
and the runtime enforces it independently:

- `dispatchOtp` short-circuits **before any network call** outside
  production (override with `POSTYAR_ALLOW_REAL_SMS_IN_DEV=1`) — no real
  SMS is ever sent from a preview;
- `bankCreatePaymentRequest` and `bankVerifyAndFinalize` both refuse to
  contact any gateway outside production (override with
  `POSTYAR_ALLOW_REAL_BANK_IN_DEV=1`) — no real charge or verify call can
  happen; card-to-card remains available;
- placeholder credentials copied from `.env.example` (`REPLACE_*`,
  `example.com` hosts) are treated as *not configured* by every resolver,
  so a template env can never trigger a real outbound request;
- e-mail is dev-gated in `src/lib/providers/email`; Telegram/Bale/Rubika
  only talk to their APIs when the user configures a bot token inside the
  preview UI, and the sandbox env ships all provider keys empty.

### One documented exception: the Bale wallet-invoice path

Bale has no separate payment API — the wallet top-up invoice flow
(`sendInvoice` → `pre_checkout_query` → `successful_payment`) runs over
the **Bot API**. It is therefore **DB-token gated, not env-gated**: if the
operator deliberately configures a REAL bot token in the preview UI, that
bot WILL talk to the real Bale API and a real invoice flow can complete.
The preview env itself ships every bot token empty, so nothing happens
unless the operator takes that deliberate action. This is why "the preview
can never contact a real payment gateway" holds for the **bank gateway
channels** (hard dev-gated) but is a **deliberate-operator exception** for
the Bale bot wallet-invoice path.

### V5 neutralization guarantees (preview-dev.sh sandbox overrides)

On top of the V4 channel neutralization, the preview script now forces:

- `POSTYAR_PUBLIC_BASE_URL=""` — an inherited value or the old
  `.env.example` placeholder (`https://postyar.example.com`) could make
  webhook registration point a real bot at a dead public URL. Forced empty,
  webhook registration degrades to the localhost dev fallback plus the cron
  poll route (`POST /api/bots/[id]/poll`), and placeholder values are
  treated as unset by `getPublicBaseUrl()` in every environment;
- `POSTYAR_ALLOW_REAL_SMS_IN_DEV=""` and `POSTYAR_ALLOW_REAL_BANK_IN_DEV=""`
  — a shell-inherited `=1` can no longer defeat the dev-suppression guards;
- `POSTYAR_AI_OLLAMA_URL=""` — a local Ollama no longer looks "available"
  in the preview provider list (only the in-house `postyar-zai` is offered);
- every per-provider AI key (`POSTYAR_AI_*_KEY`) is **unset** from the
  environment, so an inherited real key can never flow into a real billable
  provider call (the generic `POSTYAR_AI_API_KEY` is force-emptied too).

Then open the preview URL. `GET /api/health` reports component status truthfully (`app/db/storage/queue/worker`).

## What must work in a preview (checklist used for verification)

- `/` landing renders (Persian/RTL) with all assets (`/_next/static/*` → 200);
- registration creates a real user (DB write) and the session resolves;
- `/#/dashboard` renders with live server data (plans, stats, wallet);
- `/api/health` → every check `ok`;
- **no runtime errors in the browser console** — specifically, no
  `PrismaClient is unable to run in this browser environment`.

## The Prisma-in-browser rule

`src/lib/payments/plan-catalog.ts` is the **client-safe** boundary: pure
types/constants/helpers (feature catalog, quota normalization, parse
helpers). Client components MUST import it, never
`@/lib/payments/plans` (which is Prisma-backed). `plans.ts` re-exports
the catalog so every server import path keeps working. There is also no
module-load side effect anywhere that could execute DB writes from a
client bundle.

## Environment

`.env` is gitignored and must never be committed. `POSTYAR_PUBLIC_BASE_URL`
ships EMPTY (placeholders must never ship as values — the code treats
placeholder values as unset). For local preview it stays empty: payment
callback URLs degrade to relative paths and webhook registration degrades
to the localhost fallback + poll route. Production MUST set it to the real
HTTPS origin.
