// POSTYAR — /api/bots/[id]/broadcast
// POST: broadcast a message to a set of recipients via the bot's
// provider. Rate-limited (max 10/sec/bot — provider limits).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireUser,
  clientIp,
  audit,
  AuthError,
} from "@/lib/server/auth";
import { decryptString } from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/cache";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers";
import { formatJalaliDateTime } from "@/lib/persian";
import { requirePlanFeature } from "@/lib/payments/plans";

const BroadcastSchema = z.object({
  message: z.string().min(1, "متن پیام خالی است.").max(4000),
  audienceProviderUserIds: z.array(z.string().min(1).max(64)).max(5000).optional(),
});

const RATE_LIMIT_PER_SEC = 10;
const RATE_LIMIT_WINDOW_MS = 1000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  // P0.15 — server-side plan feature gate (UI hiding is not authorization).
  try {
    await requirePlanFeature(user.id, "broadcast");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status });
  }
  const { id } = await params;
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
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
  const parsed = BroadcastSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }

  // Audience resolution: explicit list, OR all distinct providerUserIds
  // from the BotHistory table (i.e. everyone who has ever spoken to the bot).
  let audience: string[] = [];
  if (parsed.data.audienceProviderUserIds && parsed.data.audienceProviderUserIds.length > 0) {
    audience = parsed.data.audienceProviderUserIds;
  } else {
    const rows = await db.botHistory.findMany({
      where: { botId: id, providerUserId: { not: null } },
      distinct: ["providerUserId"],
      select: { providerUserId: true },
      take: 5000,
    });
    audience = rows.map((r) => r.providerUserId ?? "").filter((s) => !!s);
  }
  if (audience.length === 0) {
    return NextResponse.json({ errorFa: "گیرنده‌ای برای ارسال یافت نشد." }, { status: 400 });
  }

  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return NextResponse.json({ errorFa: "توکن ربات قابل رمزگشایی نیست." }, { status: 500 });
  }
  const provider = getDestinationProvider(bot.provider);

  let sent = 0;
  let failed = 0;
  const failures: Array<{ providerUserId: string; errorFa: string }> = [];
  for (const recipient of audience) {
    // Rate-limit per bot — max 10/sec to respect provider limits.
    const rlKey = `bot:broadcast:${id}`;
    const rl = await rateLimit({
      key: rlKey,
      limit: RATE_LIMIT_PER_SEC,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    if (!rl.ok) {
      // ROOT-CAUSE FIX (audit — slowloris): the previous handling SLEPT
      // inside the request for the whole window, letting one broadcast
      // pin a Node worker for up to ~100s. Reject with 429 instead; the
      // client can retry with backoff.
      return NextResponse.json(
        { errorFa: "تعداد ارسال بیش از حد مجاز است. چند لحظه بعد تلاش کنید." },
        { status: 429 },
      );
    }
    // V5 H-04 — durable pre-write: the pending outbound row exists BEFORE
    // the provider call, so a crash after a successful send leaves an
    // auditable record instead of a silently lost history row.
    let historyId: string | null = null;
    try {
      const row = await db.botHistory.create({
        data: {
          botId: id,
          direction: "outbound",
          providerUserId: recipient,
          text: parsed.data.message.slice(0, 4000),
          userId: user.id,
          deliveryStatus: "pending",
        },
      });
      historyId = row.id;
    } catch (err) {
      // Never silent: the broadcast proceeds, but the lost tracking row is logged.
      console.error("broadcast pending history write failed:", err instanceof Error ? err.message : err);
    }
    const result = await provider.publishMessage({
      botToken,
      chatId: recipient,
      text: parsed.data.message,
    });
    // V5 H-04 — converge the row to its terminal delivery state
    // (sent + providerMessageId / failed = definitive refusal /
    // uncertain = unknown outcome — never reported as plain success).
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
        console.error("broadcast delivery state write failed:", err instanceof Error ? err.message : err);
      }
    }
    if (result.ok) {
      sent++;
    } else {
      failed++;
      failures.push({ providerUserId: recipient, errorFa: result.errorFa ?? "ارسال ناموفق بود." });
    }
  }

  await audit({
    userId: user.id,
    actor: "user",
    action: "bot_broadcast",
    targetType: "bot",
    targetId: id,
    ip,
    meta: {
      sent,
      failed,
      audienceSize: audience.length,
      messagePreview: parsed.data.message.slice(0, 80),
      at: formatJalaliDateTime(new Date().toISOString(), { withTime: true }),
    },
  });

  return NextResponse.json({
    ok: true,
    sent,
    failed,
    failures: failures.slice(0, 50), // cap the response size
  });
}
