// POSTYAR — GET /api/payments/card — list available bank cards for the user
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/server/auth";
import { listBankCards } from "@/lib/payments/bank-cards";

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  try {
    // Cards are admin-configured, shared across users. Any logged-in user
    // can see the masked list to know where to wire money to.
    void user;
    const cards = await listBankCards();
    return NextResponse.json({ items: cards });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
