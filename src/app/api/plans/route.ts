// POSTYAR — GET /api/plans — list public plans
import { NextResponse } from "next/server";
import { listPublicPlans } from "@/lib/payments/plans";

export async function GET() {
  try {
    const plans = await listPublicPlans();
    return NextResponse.json({ items: plans });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطا در دریافت پلن‌ها.";
    console.error("plans failed:", msg);
    return NextResponse.json({ errorFa: "خطا در دریافت پلن‌ها." }, { status: 500 });
  }
}
