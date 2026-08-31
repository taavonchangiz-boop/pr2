// =====================================================================
// POSTYAR — /api/tickets/[id]/replies
// ---------------------------------------------------------------------
// POST a reply with optional image/zip attachments (multipart/form-data).
// The requester MUST be the ticket owner OR a support/admin staff member.
//
// Form fields:
//   body    (string)  — reply text (min 2, max 8000 chars)
//   close   ("true")  — optional, closes the ticket after this reply
//   files   (File[])  — optional, repeated, MIME-validated image/* or .zip
//
// Files are stored under /storage/tickets/<ticketId>/<uuid>-<filename>.
// One TicketAttachment row is created per stored file linked to the reply.
// Returns { ok: true, reply: TicketReplyView } with `attachments` populated.
// =====================================================================
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/security/cache";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import {
  replyTicketWithAttachments,
  closeTicket,
  type ReplyAttachmentInput,
} from "@/lib/tickets";

const MAX_TOTAL_REPLY_BYTES = 60 * 1024 * 1024; // 60 MiB hard ceiling across all files

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json(
      { errorFa: (e as AuthError).message },
      { status: (e as AuthError).status },
    );
  }
  const ip = clientIp(req);
  const { id: ticketId } = await params;
  const isStaff = user.role === "admin" || user.role === "support";

  // Parse multipart. Next 16 + Web Request FormData handles multipart/form-data.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { errorFa: "بدنه درخواست چندبخشی نامعتبر است." },
      { status: 400 },
    );
  }

  const bodyRaw = form.get("body");
  if (typeof bodyRaw !== "string") {
    return NextResponse.json(
      { errorFa: "متن پاسخ ارسال نشده است." },
      { status: 400 },
    );
  }
  const body = bodyRaw.trim();
  if (body.length < 2) {
    return NextResponse.json(
      { errorFa: "متن پاسخ حداقل باید ۲ نویسه باشد." },
      { status: 400 },
    );
  }
  if (body.length > 8000) {
    return NextResponse.json(
      { errorFa: "متن پاسخ بیش از حد طولانی است." },
      { status: 400 },
    );
  }

  const closeRaw = form.get("close");
  const shouldClose =
    typeof closeRaw === "string" && closeRaw.toLowerCase() === "true";

  // Collect all "files" entries. formData.getAll returns an array of values.
  const fileEntries = form.getAll("files");
  const attachments: ReplyAttachmentInput[] = [];
  let totalBytes = 0;
  for (const entry of fileEntries) {
    if (!(entry instanceof File)) {
      // Skip non-file entries (e.g. accidental text fields under "files")
      continue;
    }
    if (entry.size === 0) {
      return NextResponse.json(
        { errorFa: `فایل «${entry.name}» خالی است.` },
        { status: 400 },
      );
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_REPLY_BYTES) {
      return NextResponse.json(
        { errorFa: "مجموع حجم فایل‌ها بیش از حد مجاز است." },
        { status: 400 },
      );
    }
    const buf = Buffer.from(await entry.arrayBuffer());
    attachments.push({
      fileName: entry.name,
      mime: entry.type || "application/octet-stream",
      sizeBytes: entry.size,
      buffer: buf,
    });
  }

  const r = await replyTicketWithAttachments({
    ticketId,
    userId: user.id,
    body,
    isStaff,
    attachments,
    ip,
  });
  if (!r.ok || !r.reply) {
    return NextResponse.json(
      { errorFa: r.errorFa ?? "ثبت پاسخ ناموفق بود." },
      { status: 400 },
    );
  }

  if (shouldClose) {
    await closeTicket({ ticketId, userId: user.id, isStaff, ip });
  }

  return NextResponse.json({ ok: true, reply: r.reply }, { status: 201 });
}
