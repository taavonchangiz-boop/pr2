// =====================================================================
// POSTYAR — Publishing state machine
// ---------------------------------------------------------------------
// Allowed transitions:
//   draft     → scheduled
//   draft     → queued
//   scheduled → queued
//   queued    → processing
//   processing→ delivered
//   processing→ failed
//   processing→ partial        (V5 H-16: some destinations delivered,
//                               others definitively did not receive)
//   partial   → queued         (retry: re-schedule the missing destinations)
//   partial   → cancelled
//   scheduled → cancelled
//   queued    → cancelled
//
// `partial` is intentionally NOT terminal (unlike delivered/cancelled):
// a partially-delivered content can be re-queued for the destinations
// that missed it, exactly like `failed`. It is likewise NOT a valid
// source for delivered/failed/processing — a new attempt must go through
// queued → processing so the worker's claim promotion stays the single
// entry point into an active publish.
//
// Any other transition throws an InvalidTransition error carrying the
// Persian reason. Pure functions, no side effects.
//
// sourcesFor(target) is the machine-derived reverse adjacency and is the
// SINGLE source of truth for compare-and-set content writes: writers use
// updateMany({ where: { id, status: { in: sourcesFor(target) } } }) and
// verify count, so a write can never land on a status the machine does
// not allow to move to that target (no assert-then-update TOCTOU).
// =====================================================================
export type ContentStatus =
  | "draft"
  | "scheduled"
  | "queued"
  | "processing"
  | "delivered"
  | "partial"
  | "failed"
  | "cancelled";

export class InvalidTransition extends Error {
  from: ContentStatus;
  to: ContentStatus;
  constructor(from: ContentStatus, to: ContentStatus) {
    super(`انتقال وضعیت نامعتبر: ${from} → ${to}`);
    this.name = "InvalidTransition";
    this.from = from;
    this.to = to;
  }
}

const ADJACENCY: Record<ContentStatus, ContentStatus[]> = {
  draft: ["scheduled", "queued", "cancelled"],
  scheduled: ["queued", "cancelled"],
  queued: ["processing", "cancelled"],
  processing: ["delivered", "partial", "failed"],
  partial: ["queued", "cancelled"],
  delivered: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

// Reverse adjacency, derived from ADJACENCY so the machine can never
// drift from the CAS guards built on top of it.
const TARGET_SOURCES: Record<ContentStatus, ContentStatus[]> = (() => {
  const map = {
    draft: [],
    scheduled: [],
    queued: [],
    processing: [],
    delivered: [],
    partial: [],
    failed: [],
    cancelled: [],
  } as Record<ContentStatus, ContentStatus[]>;
  for (const from of Object.keys(ADJACENCY) as ContentStatus[]) {
    for (const to of ADJACENCY[from]) {
      map[to].push(from);
    }
  }
  return map;
})();

const TERMINAL: ReadonlySet<ContentStatus> = new Set<ContentStatus>(["delivered", "cancelled"]);

export function assertTransition(from: ContentStatus, to: ContentStatus): void {
  const allowed = ADJACENCY[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransition(from, to);
  }
}

export function nextStates(from: ContentStatus): ContentStatus[] {
  return [...(ADJACENCY[from] ?? [])];
}

/** Machine-derived reverse adjacency: every status allowed to move to
 *  `target`. Use as the CAS where-clause for content status writes. */
export function sourcesFor(target: ContentStatus): ContentStatus[] {
  return [...(TARGET_SOURCES[target] ?? [])];
}

export function isTerminal(s: ContentStatus): boolean {
  return TERMINAL.has(s);
}

export function isContentStatus(s: string): s is ContentStatus {
  return [
    "draft",
    "scheduled",
    "queued",
    "processing",
    "delivered",
    "partial",
    "failed",
    "cancelled",
  ].includes(s);
}
