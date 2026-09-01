// POSTYAR — /api/content
// GET    list current user's content (filter by status, paginate, search)
// POST   create a new draft (or scheduled/queued if explicit status provided
//        AND a state-machine transition is legal — but the canonical path is
//        to create as draft and then call /api/publish/schedule).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError, safeJsonParse } from "@/lib/server/auth";
import { rateLimit } from "@/lib/security/cache";
import { isContentStatus } from "@/lib/publishing/state";

const ALLOWED_STATUSES = new Set(["draft", "scheduled", "queued", "processing", "delivered", "failed", "cancelled"]);

const CreateSchema = z.object({
  title: z.string().trim().min(3, "عنوان باید حداقل ۳ نویسه باشد.").max(200),
  body: z.string().max(20_000).default(""),
  mediaIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  destinationIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  status: z.string().optional(),
});

function toContentView(c: {
  id: string;
  title: string;
  body: string;
  status: string;
  mediaIds: string;
  destinationIds: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    title: c.title,
    body: c.body,
    status: c.status,
    mediaIds: safeJsonParse<string[]>(c.mediaIds, []),
    destinationIds: safeJsonParse<string[]>(c.destinationIds, []),
    scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
    failureReason: c.failureReason,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20));
  const q = url.searchParams.get("q")?.trim() ?? "";

  const where: {
    ownerId: string;
    status?: string;
    OR?: Array<{ title?: { contains: string }; body?: { contains: string } }>;
  } = { ownerId: user.id };
  if (status && ALLOWED_STATUSES.has(status)) where.status = status;
  if (q) {
    where.OR = [{ title: { contains: q } }, { body: { contains: q } }];
  }

  const [total, rows] = await Promise.all([
    db.content.count({ where }),
    db.content.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    items: rows.map(toContentView),
    total,
    page,
    pageSize,
  });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);

  const rl = await rateLimit({ key: `content:create:${user.id}`, limit: 30, windowMs: 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "تعداد ساخت محتوا بیش از حد مجاز است." }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const { title, body: text, mediaIds, destinationIds, status } = parsed.data;

  // Resolve destination/media IDs — P1.4 ROOT-CAUSE FIX: an ID that is not
  // owned by the user is REJECTED with a clear 403 instead of being
  // silently dropped ("drop the rest" created a different object than the
  // client requested and hid authorization failures).
  let validDestIds: string[] = [];
  if (destinationIds && destinationIds.length) {
    const uniq = Array.from(new Set(destinationIds));
    const owned = await db.destination.findMany({
      where: { id: { in: uniq }, ownerId: user.id, status: { not: "deleted" } },
      select: { id: true },
    });
    if (owned.length !== uniq.length) {
      return NextResponse.json(
        { errorFa: "یک یا چند مقصد یافت نشد یا متعلق به شما نیست." },
        { status: 403 },
      );
    }
    validDestIds = uniq;
  }

  let validMediaIds: string[] = [];
  if (mediaIds && mediaIds.length) {
    const uniq = Array.from(new Set(mediaIds));
    const owned = await db.media.findMany({
      where: { id: { in: uniq }, ownerId: user.id },
      select: { id: true },
    });
    if (owned.length !== uniq.length) {
      return NextResponse.json(
        { errorFa: "یک یا چند رسانه یافت نشد یا متعلق به شما نیست." },
        { status: 403 },
      );
    }
    validMediaIds = uniq;
  }

  // Status — only allow `draft` at creation. Other transitions must go through
  // /api/publish/schedule to keep the state machine single-path. Reject any
  // other status with a Persian error.
  let initialStatus = "draft";
  if (status) {
    if (!isContentStatus(status) || status !== "draft") {
      return NextResponse.json(
        { errorFa: "محتوای جدید فقط به‌صورت پیش‌نویس قابل ذخیره است؛ برای انتشار از زمان‌بند استفاده کنید." },
        { status: 400 },
      );
    }
    initialStatus = status;
  }

  const created = await db.content.create({
    data: {
      ownerId: user.id,
      title,
      body: text,
      status: initialStatus,
      mediaIds: JSON.stringify(validMediaIds),
      destinationIds: JSON.stringify(validDestIds),
      scheduledAt: null,
      publishedAt: null,
      failureReason: null,
    },
  });

  await audit({
    userId: user.id,
    actor: "user",
    action: "content_create",
    targetType: "content",
    targetId: created.id,
    ip,
    meta: { title: title.slice(0, 80), mediaCount: validMediaIds.length, destinationCount: validDestIds.length },
  });

  return NextResponse.json({ ok: true, content: toContentView(created) }, { status: 201 });
}
