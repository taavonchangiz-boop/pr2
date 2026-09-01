# POSTYAR — Preview Guide

## One-command preview

```bash
bash scripts/preview-dev.sh
```

The script is idempotent and safe to re-run. It:

1. creates `.env` from `.env.example` (with freshly generated dev secrets) when missing;
2. points `DATABASE_URL` at an **absolute, repo-local** SQLite file (`db/postyar-preview.db`) — an absolute URL is required because the Prisma CLI resolves relative `file:` URLs from `prisma/` while the runtime resolves them from the process cwd, which silently splits the two onto different databases;
3. applies **all migrations** with `prisma migrate deploy` (never `db push`);
4. generates the Prisma client;
5. serves on `0.0.0.0:3000` (reverse-proxy friendly — the preview gateway forwards `Host`/`X-Forwarded-*`).

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
may stay unset for local preview (payment callback URLs degrade to
relative paths); production MUST set it to the HTTPS origin.
