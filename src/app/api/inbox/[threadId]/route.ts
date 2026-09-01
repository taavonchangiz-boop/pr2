// POSTYAR — /api/inbox/[threadId]
// GET — paginated messages for a thread (threadId is `${botId}:${providerUserId}`)
// POST — send a reply to that one providerUserId via the bot's broadcast endpoint
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { decryptString } from "@/lib/security/crypto";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers";
import { rateLimit } from "@/lib/security/cache";
import { formatJalaliDateTime } from "@/lib/persian";
import { requirePlanFeature } from "@/lib/payments/plans";

function parseThreadId(threadId: string): { botId: string; providerUserId: string } | null {
  const idx = threadId.indexOf(":");
  if (idx <= 0 || idx >= threadId.length - 1) return null;
  const botId = threadId.slice(0, idx);
  const providerUserId = threadId.slice(idx + 1);
  if (!botId || !providerUserId) return null;
  return { botId, providerUserId };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const { threadId } = await params;
  const parsed = parseThreadId(threadId);
  if (!parsed) return NextResponse.json({ errorFa: "شناسه گفتگو نامعتبر است." }, { status: 400 });

  const bot = await db.bot.findFirst({
    where: { id: parsed.botId, ownerId: user.id },
    select: { id: true, provider: true, name: true, status: true },
  });
  if (!bot) return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? "50")));

  const where = {
    botId: parsed.botId,
    providerUserId: parsed.providerUserId,
  };
  const [total, rows] = await Promise.all([
    db.botHistory.count({ where }),
    db.botHistory.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        direction: true,
        providerUserId: true,
        text: true,
        createdAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    botId: parsed.botId,
    providerUserId: parsed.providerUserId,
    items: rows.map((r) => ({
      id: r.id,
      direction: r.direction === "outbound" ? "outbound" : "inbound",
      providerUserId: r.providerUserId,
      text: r.text,
      createdAt: r.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(r.createdAt, { withTime: true }),
    })),
    total,
    page,
    pageSize,
  });
}

const ReplySchema = z.object({
  message: z.string().min(1, "متن پیام خالی است.").max(4000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  // P0.15 — server-side plan feature gate (UI hiding is not authorization).
  // V5 — the inbox feature gate was previously MISSING on this route; the
  // free plan grants inbox:true, so legitimate users see no UX regression,
  // while a downgraded owner can no longer reply through the inbox API.
  try {
    await requirePlanFeature(user.id, "inbox");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status });
  }
  const { threadId } = await params;
  const parsed = parseThreadId(threadId);
  if (!parsed) return NextResponse.json({ errorFa: "شناسه گفتگو نامعتبر است." }, { status: 400 });

  const bot = await db.bot.findFirst({ where: { id: parsed.botId, ownerId: user.id } });
  if (!bot) return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  if (bot.status !== "active") {
    return NextResponse.json({ errorFa: "ربات فعال نیست." }, { status: 400 });
  }
  if (!isValidProviderName(bot.provider)) {
    return NextResponse.json({ errorFa: "پروایدر ربات نامعتبر است." }, { status: 400 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsedBody = ReplySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { errorFa: parsedBody.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }

  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return NextResponse.json({ errorFa: "توکن ربات قابل رمزگشایی نیست." }, { status: 500 });
  }
  const provider = getDestinationProvider(bot.provider);

  // Rate-limit: max 10/sec per bot
  const rl = await rateLimit({
    key: `inbox:reply:${bot.id}`,
    limit: 10,
    windowMs: 1000,
  });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "محدودیت ارسال — کمی بعد تلاش کنید." }, { status: 429 });
  }

  // V5 H-04 — durable pre-write: the pending outbound row exists BEFORE
  // the provider call (a crash after a successful send leaves an auditable
  // `pending` record instead of a silently lost history row), then the row
  // converges to sent/failed/uncertain (+ providerMessageId).
  let historyId: string | null = null;
  try {
    const row = await db.botHistory.create({
      data: {
        botId: bot.id,
        direction: "outbound",
        providerUserId: parsed.providerUserId,
        text: parsedBody.data.message.slice(0, 4000),
        userId: user.id,
        deliveryStatus: "pending",
      },
    });
    historyId = row.id;
  } catch (err) {
    // Never silent: the reply proceeds, but the lost tracking row is logged.
    console.error("inbox reply pending history write failed:", err instanceof Error ? err.message : err);
  }

  const result = await provider.publishMessage({
    botToken,
    chatId: parsed.providerUserId,
    text: parsedBody.data.message,
  });
  const deliveryStatus = result.ok ? "sent" : (result.ambiguous ? "uncertain" : "failed");
  if (historyId) {
    try {
      await db.botHistory.update({
        where: { id: historyId },
        data: {
          deliveryStatus,
          providerMessageId: result.ok ? result.providerMessageId ?? null : null,
        },
      });
    } catch (err) {
      console.error("inbox reply delivery state write failed:", err instanceof Error ? err.message : err);
    }
  }
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, sent: 0, failed: 1, errorFa: result.errorFa ?? "ارسال ناموفق بود." },
      { status: 400 },
    );
  }

  await audit({
    userId: user.id,
    actor: "user",
    action: "inbox_reply",
    targetType: "bot",
    targetId: bot.id,
    ip,
    meta: {
      providerUserId: parsed.providerUserId,
      preview: parsedBody.data.message.slice(0, 80),
      at: formatJalaliDateTime(new Date().toISOString(), { withTime: true }),
    },
  });

  return NextResponse.json({ ok: true, sent: 1, failed: 0 });
}
