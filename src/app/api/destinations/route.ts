// POSTYAR — POST /api/destinations (create)
// POST /api/destinations (create)  → verify creds BEFORE saving; encrypt token
// GET  /api/destinations           → list current user's destinations, masked
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { safeJsonParse } from "@/lib/server/auth";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { rateLimit } from "@/lib/security/cache";
import { encryptString } from "@/lib/security/crypto";
import {
  isValidProviderName,
  getDestinationProvider,
  toDestinationView,
} from "@/lib/destinations/helpers";
import { getEffectiveFeatures, getFeatureNumber } from "@/lib/payments/plans";
import { toPersianDigits } from "@/lib/persian";

const CreateSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1, "برچسب الزامی است.").max(120),
  botToken: z.string().min(8, "توکن نامعتبر است.").max(256),
  chatId: z.string().min(1, "چت‌آیدی الزامی است.").max(64),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const rows = await db.destination.findMany({
    where: { ownerId: user.id, status: { not: "deleted" } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ items: rows.map(toDestinationView) });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }

  const ip = clientIp(req);
  const rl = await rateLimit({
    key: `dst:create:${user.id}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "تعداد ساخت مقصد بیش از حد مجاز است." }, { status: 429 });
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
  const { provider, label, botToken, chatId, config } = parsed.data;
  if (!isValidProviderName(provider)) {
    return NextResponse.json({ errorFa: "پروایدر پشتیبانی نمی‌شود." }, { status: 400 });
  }

  // Verify credentials BEFORE persisting the token
  const prov = getDestinationProvider(provider);
  const verify = await prov.verifyCredentials({ botToken, chatId });
  if (!verify.ok) {
    await audit({
      userId: user.id,
      actor: "user",
      action: "destination_create_verify_failed",
      targetType: "destination",
      ip,
      meta: { provider, label, errorFa: verify.errorFa, raw: verify.raw },
    });
    return NextResponse.json(
      { errorFa: verify.errorFa ?? "اعتبارسنجی توکن ناموفق بود." },
      { status: 401 },
    );
  }

  // ROOT-CAUSE FIX (audit — plan enforcement): the plan's `channels`
  // limit was advertised to the UI but never enforced server-side; every
  // user could create unlimited destinations. Count actual destinations
  // against the active plan (0 = unlimited).
  const activeSub = await db.subscription.findFirst({
    where: { userId: user.id, status: "active", endsAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  // P0.15 + P0.2 — effective-features channels quota with explicit
  // disabled/unlimited semantics (the previous inline read of plan.quota
  // treated 0 as "no cap", i.e. unlimited — free users were uncapped).
  // limit > 0 → enforce; limit < 0 → unlimited; limit === 0 → disabled.
  {
    const features = await getEffectiveFeatures(user.id);
    const channelsLimit = getFeatureNumber(features, "channels", 1);
    if (channelsLimit === 0) {
      return NextResponse.json(
        { errorFa: "افزودن مقصد در پلن فعلی شما غیرفعال است. برای استفاده پلن را ارتقا دهید." },
        { status: 403 },
      );
    }
    if (channelsLimit > 0) {
      const destCount = await db.destination.count({ where: { ownerId: user.id } });
      if (destCount >= channelsLimit) {
        return NextResponse.json(
          { errorFa: `سقف کانال‌های پلن شما (${toPersianDigits(channelsLimit)}) تکمیل شده است. برای افزودن کانال جدید پلن را ارتقا دهید.` },
          { status: 403 },
        );
      }
    }
  }

  const created = await db.destination.create({
    data: {
      ownerId: user.id,
      provider,
      label: label.slice(0, 120),
      botTokenEnc: encryptString(botToken),
      chatId,
      config: JSON.stringify(config ?? {}),
      status: "active",
      lastCheckedAt: new Date(),
      lastError: null,
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "destination_create",
    targetType: "destination",
    targetId: created.id,
    ip,
    meta: { provider, label, chatId },
  });
  return NextResponse.json({ ok: true, destination: toDestinationView(created) }, { status: 201 });
}
