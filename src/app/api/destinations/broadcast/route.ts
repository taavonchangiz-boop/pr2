// POSTYAR — POST /api/destinations/broadcast
// ---------------------------------------------------------------------
// Bot-less broadcast: send one message to one or more destinations
// (channels/groups). Each destination is looked up, ownership is
// enforced, the token is decrypted, and `provider.publishMessage` is
// called. Rate-limited to 5 messages/sec to respect provider limits.
//
// This endpoint exists so the bot/broadcast.tsx view can compose and
// schedule a broadcast WITHOUT a pre-selected bot — the user picks
// destinations directly. The existing bot-scoped broadcast endpoint
// (`/api/bots/[id]/broadcast`) is untouched and continues to send to a
// bot's audience (providerUserIds).
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
  destinationIds: z.array(z.string().min(1).max(64)).min(1, "حداقل یک مقصد انتخاب کنید.").max(100),
});

const RATE_LIMIT_PER_SEC = 5;
const RATE_LIMIT_WINDOW_MS = 1000;

export async function POST(req: Request) {
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

  const { message, destinationIds } = parsed.data;

  // Resolve destinations in one query (ownership-enforced).
  const destinations = await db.destination.findMany({
    where: { id: { in: destinationIds }, ownerId: user.id, status: { not: "deleted" } },
    select: { id: true, provider: true, label: true, chatId: true, botTokenEnc: true, status: true },
  });
  if (destinations.length === 0) {
    return NextResponse.json({ errorFa: "مقصدی برای ارسال یافت نشد." }, { status: 400 });
  }

  let sent = 0;
  let failed = 0;
  const failures: Array<{ destinationId: string; label: string | null; errorFa: string }> = [];

  for (const d of destinations) {
    // Rate-limit per user — max 5/sec.
    const rlKey = `dst:broadcast:${user.id}`;
    const rl = await rateLimit({
      key: rlKey,
      limit: RATE_LIMIT_PER_SEC,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    if (!rl.ok) {
      // ROOT-CAUSE FIX (audit — slowloris): the previous rate-limit
      // handling SLEPT for the whole window inside the request, letting a
      // single broadcast hold a Node worker for ~100s. Reject with 429
      // instead (same as the inbox reply route).
      return NextResponse.json(
        { errorFa: "تعداد ارسال گروهی بیش از حد مجاز است. چند لحظه بعد تلاش کنید." },
        { status: 429 },
      );
    }
    if (!isValidProviderName(d.provider)) {
      failed++;
      failures.push({ destinationId: d.id, label: d.label, errorFa: "پروایدر مقصد نامعتبر است." });
      continue;
    }
    let botToken = "";
    try { botToken = decryptString(d.botTokenEnc); } catch {
      failed++;
      failures.push({ destinationId: d.id, label: d.label, errorFa: "توکن مقصد قابل رمزگشایی نیست." });
      continue;
    }
    if (!botToken) {
      failed++;
      failures.push({ destinationId: d.id, label: d.label, errorFa: "توکن مقصد خالی است." });
      continue;
    }
    const provider = getDestinationProvider(d.provider);
    const result = await provider.publishMessage({
      botToken,
      chatId: d.chatId,
      text: message,
    });
    if (result.ok) {
      sent++;
    } else {
      failed++;
      failures.push({
        destinationId: d.id,
        label: d.label,
        errorFa: result.errorFa ?? "ارسال ناموفق بود.",
      });
      // Persist lastError on the destination so the list UI can surface it.
      try {
        await db.destination.update({
          where: { id: d.id },
          data: { lastError: (result.errorFa ?? "ارسال ناموفق بود.").slice(0, 500), lastCheckedAt: new Date() },
        });
      } catch { /* ignore */ }
    }
  }

  await audit({
    userId: user.id,
    actor: "user",
    action: "destination_broadcast",
    targetType: "destination",
    targetId: destinations[0]?.id,
    ip,
    meta: {
      sent,
      failed,
      destinationCount: destinations.length,
      messagePreview: message.slice(0, 80),
      at: formatJalaliDateTime(new Date().toISOString(), { withTime: true }),
    },
  });

  return NextResponse.json({
    ok: true,
    sent,
    failed,
    failures: failures.slice(0, 50),
  });
}
