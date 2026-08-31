// POSTYAR — POST /api/ads — create an ad draft; GET /api/ads — list mine
import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/security/cache";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { createAdDraft, listMyAds } from "@/lib/payments/advertising";

const CreateSchema = z.object({
  title: z.string().min(3, "عنوان حداقل ۳ نویسه باشد.").max(200),
  descriptionFa: z.string().max(1000).optional(),
  link: z.string().max(500).refine((v) => !v || /^https?:\/\//i.test(v), "لینک باید با http(s) شروع شود.").optional().optional(),
  imageBase64: z.string().optional(),
  placement: z.string().max(40).optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  priceRials: z.number().int().nonnegative().optional(),
});

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const items = await listMyAds(user.id);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  // CPU guard (audit): image re-encoding via sharp is expensive.
  const rlAds = await rateLimit({ key: `ads:create:${user.id}`, limit: 10, windowMs: 60 * 60 * 1000 });
  if (!rlAds.ok) return NextResponse.json({ errorFa: "تعداد ساخت تبلیغ بیش از حد مجاز است." }, { status: 429 });

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
  let imageBuffer: Buffer | undefined;
  if (parsed.data.imageBase64) {
    try {
      imageBuffer = Buffer.from(parsed.data.imageBase64, "base64");
    } catch {
      return NextResponse.json({ errorFa: "تصویر base64 نامعتبر است." }, { status: 400 });
    }
  }
  try {
    const ad = await createAdDraft({
      userId: user.id,
      title: parsed.data.title,
      descriptionFa: parsed.data.descriptionFa,
      link: parsed.data.link,
      imageBuffer,
      placement: parsed.data.placement,
      startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : undefined,
      endAt: parsed.data.endAt ? new Date(parsed.data.endAt) : undefined,
      priceRials: parsed.data.priceRials,
      ip,
    });
    return NextResponse.json({ ok: true, ad }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "خطای داخلی.";
    return NextResponse.json({ errorFa: msg }, { status: 500 });
  }
}
