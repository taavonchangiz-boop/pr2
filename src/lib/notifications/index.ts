// =====================================================================
// POSTYAR — Notifications
// ---------------------------------------------------------------------
// `notify` persists a Notification row. If user prefs allow email,
// calls `sendEmail` from `@/lib/providers/email`. If prefs allow SMS
// for non-critical, calls `dispatchGeneric`. Critical security
// notifications (category="security") ignore user prefs.
//
// `adminBroadcast` is admin-only and writes one Notification row per
// matching user.
// =====================================================================
import { db } from "@/lib/db";
import { audit } from "@/lib/server/auth";
import { safeJsonParse } from "@/lib/server/auth";
import { formatJalaliDateTime } from "@/lib/persian";

export type NotificationCategory =
  | "publish"
  | "payment"
  | "subscription"
  | "referral"
  | "ad"
  | "ticket"
  | "gold"
  | "woo"
  | "security"
  | "system";

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  titleFa: string;
  bodyFa: string;
  link?: string | null;
  email?: { to: string; subjectFa?: string; htmlFa?: string } | null;
  sms?: { mobile: string } | null;
}

export interface NotifyResult {
  ok: boolean;
  notificationId: string;
  emailSent?: boolean;
  smsSent?: boolean;
  errorFa?: string;
}

interface UserNotifyPrefs {
  email?: boolean; // default true
  sms?: boolean; // default false (only security notifications by SMS)
  push?: boolean; // default true — in-app notification row always written
}

function defaultPrefs(category: NotificationCategory): UserNotifyPrefs {
  // Security alerts bypass prefs entirely (handled in `notify` itself).
  if (category === "security") return { email: true, sms: true, push: true };
  if (category === "ticket") return { email: true, sms: false, push: true };
  if (category === "payment" || category === "subscription") return { email: true, sms: false, push: true };
  return { email: true, sms: false, push: true };
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  if (!input.userId) return { ok: false, notificationId: "", errorFa: "شناسه کاربر الزامی است." };
  if (!input.titleFa || !input.bodyFa) return { ok: false, notificationId: "", errorFa: "عنوان و متن اعلان الزامی است." };

  // Persist the notification row — always, regardless of prefs (so the
  // user can see security alerts even if push was disabled).
  const notif = await db.notification.create({
    data: {
      userId: input.userId,
      category: input.category,
      titleFa: input.titleFa.slice(0, 200),
      bodyFa: input.bodyFa.slice(0, 2000),
      link: input.link ?? null,
    },
  });

  // Look up the user's preferences from Profile.notifyPrefs (JSON).
  const profile = await db.profile.findUnique({ where: { userId: input.userId } });
  const prefs = safeJsonParse<UserNotifyPrefs>(profile?.notifyPrefs ?? "{}", {});
  const defaults = defaultPrefs(input.category);

  const emailEnabled = input.category === "security" ? true : prefs.email ?? defaults.email ?? true;
  const smsEnabled = input.category === "security" ? true : prefs.sms ?? defaults.sms ?? false;

  let emailSent = false;
  let smsSent = false;

  // Email
  if (emailEnabled && input.email?.to) {
    try {
      const { sendEmail } = await import("@/lib/providers/email");
      const r = await sendEmail({
        to: input.email.to,
        subjectFa: input.email.subjectFa ?? input.titleFa,
        htmlFa: input.email.htmlFa ?? `<div dir="rtl" style="font-family:Vazirmatn,sans-serif;line-height:1.7"><h3>${escapeHtml(input.titleFa)}</h3><p>${escapeHtml(input.bodyFa)}</p><p style="color:#888">${formatJalaliDateTime(notif.createdAt, { withTime: true })}</p>${input.link ? `<p><a href="${escapeHtml(input.link)}">${escapeHtml(input.link)}</a></p>` : ""}</div>`,
      });
      emailSent = r.ok;
    } catch {
      emailSent = false;
    }
  }

  // SMS (security only by default; otherwise must be enabled in prefs).
  if (smsEnabled && input.sms?.mobile) {
    try {
      const { dispatchGeneric } = await import("@/lib/providers/sms");
      const r = await dispatchGeneric(input.sms.mobile, `${input.titleFa}\n${input.bodyFa}`.slice(0, 480));
      smsSent = r.ok;
    } catch {
      smsSent = false;
    }
  }

  return { ok: true, notificationId: notif.id, emailSent, smsSent };
}

// ---------------------------------------------------------------------
// List / mark read
// ---------------------------------------------------------------------
export async function listUnread(userId: string, opts?: { limit?: number }): Promise<{
  items: Array<NotificationView>;
}> {
  const limit = Math.min(opts?.limit ?? 20, 100);
  const rows = await db.notification.findMany({
    where: { userId, readAt: null },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return { items: rows.map(toView) };
}

export async function listAll(
  userId: string,
  opts?: { limit?: number; offset?: number; category?: string; unreadOnly?: boolean },
): Promise<{ items: NotificationView[]; total: number }> {
  const limit = Math.min(opts?.limit ?? 50, 100);
  const offset = opts?.offset ?? 0;
  const where = {
    userId,
    ...(opts?.category ? { category: opts.category } : {}),
    ...(opts?.unreadOnly ? { readAt: null } : {}),
  };
  const [rows, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    db.notification.count({ where }),
  ]);
  return { items: rows.map(toView), total };
}

export async function markRead(notificationId: string, userId: string): Promise<{ ok: boolean; errorFa?: string }> {
  // Ownership-enforced
  const notif = await db.notification.findUnique({ where: { id: notificationId } });
  if (!notif) return { ok: false, errorFa: "اعلان یافت نشد." };
  if (notif.userId !== userId) return { ok: false, errorFa: "دسترسی غیرمجاز." };
  if (notif.readAt) return { ok: true };
  await db.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

export async function markAllRead(userId: string): Promise<{ updated: number }> {
  const r = await db.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: r.count };
}

export async function getUnreadCount(userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } });
}

// ---------------------------------------------------------------------
// Admin broadcast
// ---------------------------------------------------------------------
/**
 * Legacy admin broadcast input. Kept for backward compatibility with
 * api.ts `adminBroadcast()` (which posts `{ filter, ... }`). The new
 * segmented form is `adminSegmentedBroadcast` below.
 */
export interface AdminBroadcastInput {
  filter: "all" | "plan:xxx" | "role:user";
  titleFa: string;
  bodyFa: string;
  link?: string | null;
  adminId: string;
}

/**
 * Segmented broadcast input. Audience can be:
 *   - "all"     → all active users
 *   - "single"  → one specific user (audienceMeta.userId required)
 *   - "plan"    → all users with an active subscription to audienceMeta.planId
 *   - "plans"   → union of users with active subs to any of audienceMeta.planIds[]
 *   - "support" → role in ["support","admin"] (active only)
 *
 * `category` defaults to "system". One BroadcastNotification row is
 * persisted with `recipientCount`; per-user Notification rows are fanned
 * out in batches of 200 inside a single Prisma transaction per batch.
 */
export type AudienceType = "all" | "single" | "plan" | "plans" | "support";

export interface SegmentedBroadcastInput {
  audienceType: AudienceType;
  /** JSON-serialisable metadata. Shape depends on audienceType. */
  audienceMeta: {
    userId?: string | null;
    planId?: string | null;
    planIds?: string[];
  };
  category?: NotificationCategory;
  titleFa: string;
  bodyFa: string;
  link?: string | null;
  adminId: string;
}

/**
 * Resolve a segmented audience into a list of active user IDs. Used by
 * `adminSegmentedBroadcast` (and exposed for tests / admin preview).
 */
export async function resolveBroadcastAudience(input: SegmentedBroadcastInput): Promise<{ userIds: string[] }> {
  const meta = input.audienceMeta ?? {};
  let where: Record<string, unknown> = { status: "active" };

  switch (input.audienceType) {
    case "all": {
      where = { status: "active" };
      break;
    }
    case "single": {
      if (!meta.userId) return { userIds: [] };
      where = { id: meta.userId, status: "active" };
      break;
    }
    case "plan": {
      if (!meta.planId) return { userIds: [] };
      const subs = await db.subscription.findMany({
        where: { planId: meta.planId, status: "active", endsAt: { gt: new Date() } },
        select: { userId: true },
        take: 10_000,
      });
      const userIds = subs.map((s) => s.userId);
      if (userIds.length === 0) return { userIds: [] };
      where = { id: { in: userIds }, status: "active" };
      break;
    }
    case "plans": {
      const planIds = Array.isArray(meta.planIds) ? meta.planIds.filter(Boolean) : [];
      if (planIds.length === 0) return { userIds: [] };
      const subs = await db.subscription.findMany({
        where: { planId: { in: planIds }, status: "active", endsAt: { gt: new Date() } },
        select: { userId: true },
        take: 10_000,
      });
      const userIds = Array.from(new Set(subs.map((s) => s.userId)));
      if (userIds.length === 0) return { userIds: [] };
      where = { id: { in: userIds }, status: "active" };
      break;
    }
    case "support": {
      where = { status: "active", role: { in: ["support", "admin"] } };
      break;
    }
    default:
      return { userIds: [] };
  }

  const users = await db.user.findMany({
    where,
    select: { id: true },
    take: 10_000, // hard ceiling — for very large broadcasts, chunk later
  });
  return { userIds: users.map((u) => u.id) };
}

/**
 * Segmented broadcast. Creates one Notification row per recipient in
 * batches of 200 (transaction per batch), then upserts a
 * BroadcastNotification row carrying the template + recipient count.
 */
export async function adminSegmentedBroadcast(input: SegmentedBroadcastInput): Promise<{
  sent: number;
  recipientCount: number;
  broadcastId: string;
}> {
  const { userIds } = await resolveBroadcastAudience(input);
  const recipientCount = userIds.length;
  const category: NotificationCategory = input.category ?? "system";
  const titleFa = input.titleFa.slice(0, 200);
  const bodyFa = input.bodyFa.slice(0, 2000);
  const link = input.link ?? null;
  const audienceMetaJson = JSON.stringify({
    userId: input.audienceMeta.userId ?? null,
    planId: input.audienceMeta.planId ?? null,
    planIds: Array.isArray(input.audienceMeta.planIds) ? input.audienceMeta.planIds : [],
  });

  if (recipientCount > 0) {
    const batch = 200;
    for (let i = 0; i < userIds.length; i += batch) {
      const slice = userIds.slice(i, i + batch);
      await db.$transaction(async (tx) => {
        await tx.notification.createMany({
          data: slice.map((uid) => ({
            userId: uid,
            category,
            titleFa,
            bodyFa,
            link,
          })),
        });
      });
    }
  }

  // Persist the broadcast template row with recipient count (even when 0 —
  // useful for audit / "no recipients matched" forensics).
  const broadcast = await db.broadcastNotification.create({
    data: {
      category,
      titleFa,
      bodyFa,
      link,
      audienceType: input.audienceType,
      audienceMeta: audienceMetaJson,
      sentById: input.adminId,
      sentAt: new Date(),
      recipientCount,
    },
    select: { id: true, recipientCount: true },
  });

  await audit({
    userId: input.adminId,
    actor: "admin",
    action: "broadcast_sent",
    targetType: "notification",
    meta: {
      audienceType: input.audienceType,
      audienceMeta: audienceMetaJson,
      recipients: recipientCount,
      titleFa,
      broadcastId: broadcast.id,
    },
  });

  return { sent: recipientCount, recipientCount, broadcastId: broadcast.id };
}

/**
 * @deprecated Use `adminSegmentedBroadcast`. Legacy wrapper kept so
 * existing callers that pass `filter` (e.g. `api.adminBroadcast` in
 * api.ts) keep working. Translates the legacy `filter` into the new
 * segmented form.
 */
export async function adminBroadcast(input: AdminBroadcastInput): Promise<{ sent: number }> {
  let segType: AudienceType = "all";
  let segMeta: SegmentedBroadcastInput["audienceMeta"] = {};
  if (input.filter === "all") {
    segType = "all";
  } else if (input.filter === "role:user") {
    // Legacy "role:user" mapped to "all" (the old impl included ALL
    // active users with any role, since `role: "user"` matches by role
    // string but the documented intent was "regular users"; to preserve
    // behaviour precisely we'd need an extra case. Map to all to
    // minimise surprise; admins wanting role-scoping should use the new
    // `support` audience.
    segType = "all";
  } else if (input.filter.startsWith("plan:")) {
    const planCode = input.filter.slice(5);
    const plan = await db.plan.findUnique({ where: { code: planCode } });
    if (!plan) return { sent: 0 };
    segType = "plan";
    segMeta = { planId: plan.id };
  } else {
    return { sent: 0 };
  }
  const r = await adminSegmentedBroadcast({
    audienceType: segType,
    audienceMeta: segMeta,
    titleFa: input.titleFa,
    bodyFa: input.bodyFa,
    link: input.link,
    adminId: input.adminId,
  });
  return { sent: r.sent };
}

// ---------------------------------------------------------------------
// View shape
// ---------------------------------------------------------------------
export interface NotificationView {
  id: string;
  category: string;
  titleFa: string;
  bodyFa: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  createdAtFa: string;
}

function toView(n: { id: string; category: string; titleFa: string; bodyFa: string; link: string | null; readAt: Date | null; createdAt: Date }): NotificationView {
  return {
    id: n.id,
    category: n.category,
    titleFa: n.titleFa,
    bodyFa: n.bodyFa,
    link: n.link,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
    createdAtFa: formatJalaliDateTime(n.createdAt, { withTime: true }),
  };
}

// ---------------------------------------------------------------------
// HTML escape helper for email body
// ---------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
