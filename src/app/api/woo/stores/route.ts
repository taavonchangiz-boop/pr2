// POSTYAR — /api/woo/stores
// GET list mine, POST create store (encrypt + testConnection before save)
import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/security/cache";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { listMyStores, createStore } from "@/lib/providers/woo";

const CreateSchema = z.object({
  storeUrl: z.string().min(5, "آدرس فروشگاه نامعتبر است.").max(200),
  consumerKey: z.string().min(8, "کلید مصرف‌کننده نامعتبر است.").max(120),
  consumerSecret: z.string().min(8, "رمز مصرف‌کننده نامعتبر است.").max(120),
});

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const items = await listMyStores(user.id);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  // SSRF amplification guard (audit WO1): throttle store creation probes.
  const rlWoo = await rateLimit({ key: `woo:create:${user.id}`, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rlWoo.ok) return NextResponse.json({ errorFa: "تعداد ثبت فروشگاه بیش از حد مجاز است." }, { status: 429 });
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
  const r = await createStore({
    userId: user.id,
    storeUrl: parsed.data.storeUrl,
    consumerKey: parsed.data.consumerKey,
    consumerSecret: parsed.data.consumerSecret,
    ip,
  });
  if (!r.ok || !r.store) {
    return NextResponse.json({ errorFa: r.errorFa ?? "افزودن فروشگاه ناموفق بود." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, store: r.store }, { status: 201 });
}
