// =====================================================================
// POSTYAR — the canonical AuthError class (client-safe)
// ---------------------------------------------------------------------
// V6 M-01 — there was exactly ONE AuthError before, but it was DEFINED
// twice: once in `@/lib/server/auth` (server-only: pulls next/headers +
// ioredis) and once in `@/lib/payments/plans` (the client-safe plan
// boundary, which must never import server auth). Two classes with the
// same shape are different VALUES at runtime, so `err instanceof
// AuthError` failed across the boundary and routes misclassified plan
// errors (the tickets 403 gate surfaced as a 500).
//
// The class now lives HERE — a dependency-free module importable from
// client bundles — and both former definition sites re-export this exact
// identity, so instanceof works everywhere while every import path keeps
// compiling unchanged.
// =====================================================================
export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
    this.name = "AuthError";
  }
}
