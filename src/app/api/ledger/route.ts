// POSTYAR — GET /api/ledger — my ledger entries (paginated)
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/server/auth";
import { getLedgerEntries } from "@/lib/payments/wallet";

export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const url = new URL(req.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
  try {
    const items = await getLedgerEntries(user.id, {
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    });
    return NextResponse.json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطا در دریافت دفتر عملیات.";
    console.error("ledger failed:", msg);
    return NextResponse.json({ errorFa: "خطا در دریافت دفتر عملیات." }, { status: 500 });
  }
}
