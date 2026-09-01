// POSTYAR — POST /api/admin/notifications/broadcast (admin only)
// Accepts the segmented form: { category?, titleFa, bodyFa, link?,
// audienceType: "all"|"single"|"plan"|"plans"|"support", audienceMeta }.
// Legacy form { filter, ... } is still accepted for backward compat.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, AuthError } from "@/lib/server/auth";
import { adminSegmentedBroadcast, adminBroadcast } from "@/lib/notifications";

const AudienceSchema = z.enum(["all", "single", "plan", "plans", "support"]);

const SegmentedSchema = z.object({
  audienceType: AudienceSchema,
  audienceMeta: z
    .object({
      userId: z.string().min(1).optional().nullable(),
      planId: z.string().min(1).optional().nullable(),
      planIds: z.array(z.string().min(1)).optional(),
    })
    .optional()
    .default({}),
  category: z
    .enum([
      "publish",
      "payment",
      "subscription",
      "referral",
      "ad",
      "ticket",
      "gold",
      "woo",
      "security",
      "system",
    ])
    .optional(),
  titleFa: z.string().min(1, "عنوان الزامی است.").max(200),
  bodyFa: z.string().min(1, "متن الزامی است.").max(2000),
  link: z
    .string()
    .url("لینک نامعتبر است.")
    .optional()
    .or(z.literal("")),
});

const LegacySchema = z.object({
  filter: z
    .enum(["all", "role:user"])
    .or(z.string().regex(/^plan:.+$/, "فیلتر باید all، role:user یا plan:code باشد.")),
  titleFa: z.string().min(1, "عنوان الزامی است.").max(200),
  bodyFa: z.string().min(1, "متن الزامی است.").max(2000),
  link: z
    .string()
    .url("لینک نامعتبر است.")
    .optional()
    .or(z.literal("")),
});

function isSegmented(body: unknown): body is z.infer<typeof SegmentedSchema> {
  return !!body && typeof body === "object" && "audienceType" in (body as Record<string, unknown>);
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireRole(["admin"]);
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  void ip;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }

  // ----- Segmented form (preferred) -----
  if (isSegmented(body)) {
    const parsed = SegmentedSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
        { status: 400 },
      );
    }
    // Validate audienceMeta against audienceType.
    const at = parsed.data.audienceType;
    const meta = parsed.data.audienceMeta ?? {};
    if (at === "single" && !meta.userId) {
      return NextResponse.json(
        { errorFa: "برای مخاطب «یک کاربر»، شناسه کاربر الزامی است." },
        { status: 400 },
      );
    }
    if (at === "plan" && !meta.planId) {
      return NextResponse.json(
        { errorFa: "برای مخاطب «کاربران یک اشتراک»، شناسه پلن الزامی است." },
        { status: 400 },
      );
    }
    if (at === "plans" && (!Array.isArray(meta.planIds) || meta.planIds.length === 0)) {
      return NextResponse.json(
        { errorFa: "برای مخاطب «کاربران چند اشتراک»، حداقل یک پلن انتخاب کنید." },
        { status: 400 },
      );
    }
    try {
      const r = await adminSegmentedBroadcast({
        audienceType: at,
        audienceMeta: {
          userId: meta.userId ?? null,
          planId: meta.planId ?? null,
          planIds: meta.planIds ?? [],
        },
        category: parsed.data.category,
        titleFa: parsed.data.titleFa,
        bodyFa: parsed.data.bodyFa,
        link: parsed.data.link || null,
        adminId: user.id,
      });
      return NextResponse.json({
        ok: true,
        sent: r.sent,
        recipientCount: r.recipientCount,
        broadcastId: r.broadcastId,
      });
    } catch (err) {
      // V4 M-13 — bounded Persian for the client; internals stay server-side.
      console.error("admin segmented broadcast failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ errorFa: "ارسال اعلان ناموفق بود. لطفاً دوباره تلاش کنید." }, { status: 500 });
    }
  }

  // ----- Legacy form (backward compat for api.adminBroadcast in api.ts) -----
  const parsed = LegacySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const r = await adminBroadcast({
    filter: parsed.data.filter as "all" | "plan:xxx" | "role:user",
    titleFa: parsed.data.titleFa,
    bodyFa: parsed.data.bodyFa,
    link: parsed.data.link || null,
    adminId: user.id,
  });
  return NextResponse.json({ ok: true, sent: r.sent });
}
