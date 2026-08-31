// POSTYAR — GET /api/discounts — validate a discount code (preview only)
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/server/auth";
import { previewDiscount } from "@/lib/payments/discount";

export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const planId = url.searchParams.get("planId") ?? undefined;
  const amountRaw = Number(url.searchParams.get("amount") ?? "0");
  if (!code) {
    return NextResponse.json({ errorFa: "کد تخفیف الزامی است." }, { status: 400 });
  }
  if (!Number.isFinite(amountRaw) || amountRaw < 0) {
    return NextResponse.json({ errorFa: "مبلغ نامعتبر است." }, { status: 400 });
  }
  try {
    const result = await previewDiscount({
      code,
      userId: user.id,
      planId: planId,
      amount: Math.round(amountRaw),
    });
    if (!result.ok) {
      return NextResponse.json({ errorFa: result.errorFa }, { status: 400 });
    }
    const { ok, ...rest } = result;
    void ok;
    return NextResponse.json({ ok: true, ...rest });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطا در بررسی کد تخفیف.";
    console.error("discounts failed:", msg);
    return NextResponse.json({ errorFa: "خطا در بررسی کد تخفیف." }, { status: 500 });
  }
}
