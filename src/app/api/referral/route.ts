// POSTYAR — GET /api/referral — my referral stats
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/server/auth";
import { getMyReferralStats, describeRewardPolicyFa } from "@/lib/payments/referral";

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  try {
    const stats = await getMyReferralStats(user.id);
    return NextResponse.json({ ...stats, policyFa: describeRewardPolicyFa() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطا در دریافت اطلاعات معرفی.";
    console.error("referral failed:", msg);
    return NextResponse.json({ errorFa: "خطا در دریافت اطلاعات معرفی." }, { status: 500 });
  }
}
