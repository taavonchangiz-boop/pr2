// POSTYAR — GET /api/wallet — balance + paginated history
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/server/auth";
import { getBalance, getWalletHistory } from "@/lib/payments/wallet";

export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const url = new URL(req.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
  try {
    const [balance, history] = await Promise.all([
      getBalance(user.id),
      getWalletHistory(user.id, { page: Number.isFinite(page) ? page : 1, pageSize: Number.isFinite(pageSize) ? pageSize : 20 }),
    ]);
    return NextResponse.json({ balance, history });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطا در دریافت کیف پول.";
    console.error("wallet failed:", msg);
    return NextResponse.json({ errorFa: "خطا در دریافت کیف پول." }, { status: 500 });
  }
}
