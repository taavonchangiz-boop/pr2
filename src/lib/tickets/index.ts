// =====================================================================
// POSTYAR — Tickets
// ---------------------------------------------------------------------
// Support tickets with replies. Owners reply; staff can reply to any;
// only owner/staff can close; only admins can assign departments and
// support staff and set priority. Replies may carry image/zip attachments.
// All ops are audited.
// =====================================================================
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { audit, AuthError } from "@/lib/server/auth";
import { formatJalaliDateTime } from "@/lib/persian";
import { notify } from "@/lib/notifications";
import { STORAGE_ROOT } from "@/lib/storage";

export type TicketCategory = "general" | "billing" | "technical" | "ai" | "gold" | "woo" | "bot" | "security";
export type TicketStatus = "open" | "answered" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

const CATEGORY_FA: Record<TicketCategory, string> = {
  general: "عمومی",
  billing: "مالی",
  technical: "فنی",
  ai: "هوش مصنوعی",
  gold: "طلا",
  woo: "ووکامرس",
  bot: "ربات",
  security: "امنیتی",
};

const PRIORITY_FA: Record<TicketPriority, string> = {
  low: "کم",
  normal: "عادی",
  high: "زیاد",
  urgent: "فوری",
};

export function categoryFa(c: string): string {
  return CATEGORY_FA[c as TicketCategory] ?? c;
}
export function priorityFa(p: string): string {
  return PRIORITY_FA[p as TicketPriority] ?? p;
}

// ---------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------
export interface TicketView {
  id: string;
  subject: string;
  category: string;
  categoryFa: string;
  status: string;
  priority: string;
  priorityFa: string;
  ownerId: string;
  ownerNameFa: string;
  assignedToId: string | null;
  assignedToNameFa: string | null;
  departmentId?: string | null;
  departmentNameFa?: string | null;
  createdAt: string;
  createdAtFa: string;
  updatedAt: string;
  updatedAtFa: string;
  replyCount: number;
}

export interface TicketReplyView {
  id: string;
  body: string;
  isStaff: boolean;
  authorNameFa: string;
  createdAt: string;
  createdAtFa: string;
  attachments?: TicketAttachmentView[];
}

export interface TicketAttachmentView {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
  createdAtFa: string;
}

export interface TicketDepartmentView {
  id: string;
  nameFa: string;
  descriptionFa: string;
  priority: number;
  active: boolean;
  ticketCount: number;
  createdAt: string;
  createdAtFa: string;
  updatedAt: string;
  updatedAtFa: string;
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------
export async function createTicket(input: {
  userId: string;
  subject: string;
  category?: TicketCategory;
  priority?: TicketPriority;
  departmentId?: string | null;
  body: string;
  ip?: string;
}): Promise<{ ok: boolean; ticket?: TicketView; errorFa?: string }> {
  const subject = (input.subject ?? "").trim();
  const body = (input.body ?? "").trim();
  if (subject.length < 3) return { ok: false, errorFa: "موضوع تیکت حداقل باید ۳ نویسه باشد." };
  if (body.length < 3) return { ok: false, errorFa: "متن تیکت حداقل باید ۳ نویسه باشد." };

  // Optional department assignment — validate FK exists + is active.
  let departmentId: string | null = null;
  if (input.departmentId !== undefined && input.departmentId !== null && input.departmentId !== "") {
    const dep = await db.ticketDepartment.findUnique({ where: { id: input.departmentId } });
    if (!dep) return { ok: false, errorFa: "دپارتمان انتخاب‌شده یافت نشد." };
    if (!dep.active) return { ok: false, errorFa: "دپارتمان انتخاب‌شده غیرفعال است." };
    departmentId = dep.id;
  }

  const ticket = await db.ticket.create({
    data: {
      userId: input.userId,
      subject: subject.slice(0, 200),
      category: input.category ?? "general",
      priority: input.priority ?? "normal",
      status: "open",
      departmentId,
      replies: {
        create: {
          userId: input.userId,
          body: body.slice(0, 8000),
          isStaff: false,
        },
      },
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, businessName: true } },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      department: { select: { id: true, nameFa: true } },
      replies: true,
    },
  });

  await audit({
    userId: input.userId,
    actor: "user",
    action: "ticket_created",
    targetType: "ticket",
    targetId: ticket.id,
    ip: input.ip,
    meta: { category: ticket.category, priority: ticket.priority, departmentId },
  });

  return { ok: true, ticket: toView(ticket) };
}

// ---------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------
export async function replyTicket(input: {
  ticketId: string;
  userId: string;
  body: string;
  isStaff?: boolean;
  ip?: string;
}): Promise<{ ok: boolean; reply?: TicketReplyView; errorFa?: string }> {
  const body = (input.body ?? "").trim();
  if (body.length < 2) return { ok: false, errorFa: "متن پاسخ حداقل باید ۲ نویسه باشد." };

  const ticket = await db.ticket.findUnique({
    where: { id: input.ticketId },
    include: { user: { select: { id: true, email: true, mobile: true, firstName: true, lastName: true } } },
  });
  if (!ticket) return { ok: false, errorFa: "تیکت یافت نشد." };

  // Ownership enforcement: owner OR staff (role support/admin) can reply.
  if (input.isStaff !== true && ticket.userId !== input.userId) {
    return { ok: false, errorFa: "دسترسی غیرمجاز." };
  }
  if (ticket.status === "closed") {
    return { ok: false, errorFa: "تیکت بسته شده است." };
  }

  const reply = await db.ticketReply.create({
    data: {
      ticketId: input.ticketId,
      userId: input.userId,
      body: body.slice(0, 8000),
      isStaff: input.isStaff === true,
    },
    include: { user: { select: { firstName: true, lastName: true, role: true } } },
  });

  // Update ticket status
  const newStatus: TicketStatus = input.isStaff ? "answered" : "open";
  await db.ticket.update({
    where: { id: input.ticketId },
    data: { status: newStatus },
  });

  await audit({
    userId: input.userId,
    actor: input.isStaff ? "support" : "user",
    action: "ticket_reply",
    targetType: "ticket",
    targetId: input.ticketId,
    ip: input.ip,
    meta: { isStaff: input.isStaff === true },
  });

  // Notify the OTHER party
  const recipientId = input.isStaff ? ticket.userId : (ticket.assignedToId ?? null);
  if (recipientId && recipientId !== input.userId) {
    await notify({
      userId: recipientId,
      category: "ticket",
      titleFa: `پاسخ تیکت: ${ticket.subject}`,
      bodyFa: `یک پاسخ جدید روی تیکت «${ticket.subject}» ثبت شد.`,
      link: "/dashboard/tickets",
      email: ticket.user?.email ? { to: ticket.user.email } : null,
    });
  }

  return {
    ok: true,
    reply: {
      id: reply.id,
      body: reply.body,
      isStaff: reply.isStaff,
      authorNameFa: userFullName(reply.user),
      createdAt: reply.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(reply.createdAt, { withTime: true }),
    },
  };
}

// ---------------------------------------------------------------------
// Close (owner or staff)
// ---------------------------------------------------------------------
export async function closeTicket(input: {
  ticketId: string;
  userId: string;
  isStaff?: boolean;
  ip?: string;
}): Promise<{ ok: boolean; errorFa?: string }> {
  const ticket = await db.ticket.findUnique({ where: { id: input.ticketId } });
  if (!ticket) return { ok: false, errorFa: "تیکت یافت نشد." };
  if (input.isStaff !== true && ticket.userId !== input.userId) {
    return { ok: false, errorFa: "دسترسی غیرمجاز." };
  }
  if (ticket.status === "closed") return { ok: true };
  await db.ticket.update({
    where: { id: input.ticketId },
    data: { status: "closed" },
  });
  await audit({
    userId: input.userId,
    actor: input.isStaff ? "support" : "user",
    action: "ticket_closed",
    targetType: "ticket",
    targetId: input.ticketId,
    ip: input.ip,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------
// Assign (admin only)
// ---------------------------------------------------------------------
export async function assignTicket(input: {
  ticketId: string;
  supportUserId: string;
  adminId: string;
  ip?: string;
}): Promise<{ ok: boolean; errorFa?: string }> {
  const ticket = await db.ticket.findUnique({ where: { id: input.ticketId } });
  if (!ticket) return { ok: false, errorFa: "تیکت یافت نشد." };
  const supporter = await db.user.findUnique({ where: { id: input.supportUserId } });
  if (!supporter) return { ok: false, errorFa: "کاربر پشتیبان یافت نشد." };
  if (supporter.role !== "support" && supporter.role !== "admin") {
    return { ok: false, errorFa: "فقط کاربران پشتیبان یا مدیر قابل اختصاص هستند." };
  }
  await db.ticket.update({
    where: { id: input.ticketId },
    data: { assignedToId: input.supportUserId },
  });
  await audit({
    userId: input.adminId,
    actor: "admin",
    action: "ticket_assigned",
    targetType: "ticket",
    targetId: input.ticketId,
    ip: input.ip,
    meta: { supportUserId: input.supportUserId },
  });
  // Notify the supporter
  await notify({
    userId: input.supportUserId,
    category: "ticket",
    titleFa: "تیکت جدید به شما اختصاص یافت",
    bodyFa: `تیکت «${ticket.subject}» به شما اختصاص یافت.`,
    link: "/dashboard/tickets",
  });
  return { ok: true };
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------
export async function listMyTickets(
  userId: string,
  opts?: { limit?: number; offset?: number; status?: string; departmentId?: string | null },
): Promise<{ items: TicketView[]; total: number }> {
  const limit = Math.min(opts?.limit ?? 50, 100);
  const offset = opts?.offset ?? 0;
  const where: Record<string, unknown> = { userId };
  if (opts?.status) where.status = opts.status;
  if (opts?.departmentId !== undefined) where.departmentId = opts.departmentId ?? null;
  const [rows, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        department: { select: { id: true, nameFa: true } },
        replies: { select: { id: true } },
      },
    }),
    db.ticket.count({ where }),
  ]);
  return { items: rows.map(toView), total };
}

export async function listAllTicketsForAdmin(
  opts?: { limit?: number; offset?: number; status?: string; assignedToId?: string | null; departmentId?: string | null },
): Promise<{ items: TicketView[]; total: number }> {
  const limit = Math.min(opts?.limit ?? 50, 200);
  const offset = opts?.offset ?? 0;
  const where: Record<string, unknown> = {};
  if (opts?.status) where.status = opts.status;
  if (opts?.assignedToId !== undefined) where.assignedToId = opts.assignedToId;
  if (opts?.departmentId !== undefined) where.departmentId = opts.departmentId ?? null;
  const [rows, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        department: { select: { id: true, nameFa: true } },
        replies: { select: { id: true } },
      },
    }),
    db.ticket.count({ where }),
  ]);
  return { items: rows.map(toView), total };
}

export async function getTicket(
  ticketId: string,
  userId: string,
  isStaff: boolean,
): Promise<{ ok: boolean; ticket?: TicketView; replies?: TicketReplyView[]; errorFa?: string }> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, businessName: true } },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      department: { select: { id: true, nameFa: true } },
      replies: {
        orderBy: { createdAt: "asc" },
        include: {
          user: { select: { firstName: true, lastName: true, role: true } },
          attachments: true,
        },
      },
    },
  });
  if (!ticket) return { ok: false, errorFa: "تیکت یافت نشد." };
  if (!isStaff && ticket.userId !== userId) return { ok: false, errorFa: "دسترسی غیرمجاز." };
  return {
    ok: true,
    ticket: toView(ticket),
    replies: ticket.replies.map((r) => ({
      id: r.id,
      body: r.body,
      isStaff: r.isStaff,
      authorNameFa: userFullName(r.user),
      createdAt: r.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(r.createdAt, { withTime: true }),
      attachments: (r.attachments ?? []).map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt.toISOString(),
        createdAtFa: formatJalaliDateTime(a.createdAt, { withTime: true }),
      })),
    })),
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function userFullName(u?: { firstName: string; lastName: string; businessName?: string } | null): string {
  if (!u) return "ناشناخته";
  const full = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  if (full) return full;
  return u.businessName || "ناشناخته";
}

function toView(t: {
  id: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  userId: string;
  user?: { id: string; firstName: string; lastName: string; businessName?: string } | null;
  assignedToId: string | null;
  assignedTo?: { id: string; firstName: string; lastName: string } | null;
  departmentId?: string | null;
  department?: { id: string; nameFa: string } | null;
  createdAt: Date;
  updatedAt: Date;
  replies?: Array<{ id: string }> | Array<unknown>;
}): TicketView {
  const replyCount = Array.isArray(t.replies) ? t.replies.length : 0;
  return {
    id: t.id,
    subject: t.subject,
    category: t.category,
    categoryFa: categoryFa(t.category),
    status: t.status,
    priority: t.priority,
    priorityFa: priorityFa(t.priority),
    ownerId: t.userId,
    ownerNameFa: userFullName(t.user ?? null),
    assignedToId: t.assignedToId,
    assignedToNameFa: t.assignedTo ? userFullName(t.assignedTo) : null,
    departmentId: t.departmentId ?? null,
    departmentNameFa: t.department?.nameFa ?? null,
    createdAt: t.createdAt.toISOString(),
    createdAtFa: formatJalaliDateTime(t.createdAt, { withTime: true }),
    updatedAt: t.updatedAt.toISOString(),
    updatedAtFa: formatJalaliDateTime(t.updatedAt, { withTime: true }),
    replyCount,
  };
}

export { AuthError };

// =====================================================================
// DEPARTMENTS — admin CRUD
// =====================================================================
const TICKET_STORAGE_DIR = path.join(STORAGE_ROOT, "tickets");

async function ensureTicketStorage(ticketId: string): Promise<string> {
  const dir = path.join(TICKET_STORAGE_DIR, ticketId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function listDepartments(
  opts?: { activeOnly?: boolean },
): Promise<{ items: TicketDepartmentView[] }> {
  const where: Record<string, unknown> = {};
  if (opts?.activeOnly) where.active = true;
  const rows = await db.ticketDepartment.findMany({
    where,
    orderBy: [{ priority: "asc" }, { nameFa: "asc" }],
    include: { _count: { select: { tickets: true } } },
  });
  return {
    items: rows.map((d) => ({
      id: d.id,
      nameFa: d.nameFa,
      descriptionFa: d.descriptionFa,
      priority: d.priority,
      active: d.active,
      ticketCount: d._count?.tickets ?? 0,
      createdAt: d.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(d.createdAt, { withTime: false }),
      updatedAt: d.updatedAt.toISOString(),
      updatedAtFa: formatJalaliDateTime(d.updatedAt, { withTime: false }),
    })),
  };
}

export async function createDepartment(input: {
  nameFa: string;
  descriptionFa?: string;
  priority?: number;
  active?: boolean;
}): Promise<{ ok: boolean; department?: TicketDepartmentView; errorFa?: string }> {
  const nameFa = (input.nameFa ?? "").trim();
  if (nameFa.length < 1) return { ok: false, errorFa: "نام دپارتمان لازم است." };
  if (nameFa.length > 60) return { ok: false, errorFa: "نام دپارتمان بیش از حد طولانی است." };
  const priority = Number.isFinite(input.priority as number) ? Number(input.priority) : 100;
  const existing = await db.ticketDepartment.findUnique({ where: { nameFa } });
  if (existing) return { ok: false, errorFa: "دپارتمانی با این نام وجود دارد." };
  const created = await db.ticketDepartment.create({
    data: {
      nameFa,
      descriptionFa: (input.descriptionFa ?? "").slice(0, 500),
      priority,
      active: input.active ?? true,
    },
  });
  return {
    ok: true,
    department: {
      id: created.id,
      nameFa: created.nameFa,
      descriptionFa: created.descriptionFa,
      priority: created.priority,
      active: created.active,
      ticketCount: 0,
      createdAt: created.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(created.createdAt, { withTime: false }),
      updatedAt: created.updatedAt.toISOString(),
      updatedAtFa: formatJalaliDateTime(created.updatedAt, { withTime: false }),
    },
  };
}

export async function updateDepartment(input: {
  id: string;
  nameFa?: string;
  descriptionFa?: string;
  priority?: number;
  active?: boolean;
}): Promise<{ ok: boolean; errorFa?: string }> {
  const existing = await db.ticketDepartment.findUnique({ where: { id: input.id } });
  if (!existing) return { ok: false, errorFa: "دپارتمان یافت نشد." };
  const data: Record<string, unknown> = {};
  if (typeof input.nameFa === "string") {
    const nameFa = input.nameFa.trim();
    if (nameFa.length < 1) return { ok: false, errorFa: "نام دپارتمان لازم است." };
    if (nameFa.length > 60) return { ok: false, errorFa: "نام دپارتمان بیش از حد طولانی است." };
    if (nameFa !== existing.nameFa) {
      const clash = await db.ticketDepartment.findUnique({ where: { nameFa } });
      if (clash) return { ok: false, errorFa: "دپارتمانی با این نام وجود دارد." };
    }
    data.nameFa = nameFa;
  }
  if (typeof input.descriptionFa === "string") {
    data.descriptionFa = input.descriptionFa.slice(0, 500);
  }
  if (Number.isFinite(input.priority as number)) {
    data.priority = Number(input.priority);
  }
  if (typeof input.active === "boolean") {
    data.active = input.active;
  }
  if (Object.keys(data).length === 0) return { ok: true };
  await db.ticketDepartment.update({ where: { id: input.id }, data });
  return { ok: true };
}

export async function deleteDepartment(id: string): Promise<{ ok: boolean; errorFa?: string }> {
  const existing = await db.ticketDepartment.findUnique({ where: { id } });
  if (!existing) return { ok: false, errorFa: "دپارتمان یافت نشد." };
  // Schema onDelete: SetNull — all tickets.departmentId will be nullified.
  await db.ticketDepartment.delete({ where: { id } });
  return { ok: true };
}

// =====================================================================
// ADMIN ASSIGN — set department / support / priority in one call
// =====================================================================
export async function assignTicketFields(input: {
  ticketId: string;
  adminId: string;
  departmentId?: string | null;
  assignedToId?: string | null;
  priority?: TicketPriority;
  ip?: string;
}): Promise<{ ok: boolean; errorFa?: string }> {
  const ticket = await db.ticket.findUnique({ where: { id: input.ticketId } });
  if (!ticket) return { ok: false, errorFa: "تیکت یافت نشد." };

  const data: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};

  if (input.departmentId !== undefined) {
    if (input.departmentId === null || input.departmentId === "") {
      data.departmentId = null;
      meta.departmentId = null;
    } else {
      const dep = await db.ticketDepartment.findUnique({ where: { id: input.departmentId } });
      if (!dep) return { ok: false, errorFa: "دپارتمان یافت نشد." };
      data.departmentId = dep.id;
      meta.departmentId = dep.id;
      meta.departmentNameFa = dep.nameFa;
    }
  }

  if (input.assignedToId !== undefined) {
    if (input.assignedToId === null || input.assignedToId === "") {
      data.assignedToId = null;
      meta.assignedToId = null;
    } else {
      const supporter = await db.user.findUnique({ where: { id: input.assignedToId } });
      if (!supporter) return { ok: false, errorFa: "کاربر پشتیبان یافت نشد." };
      if (supporter.role !== "support" && supporter.role !== "admin") {
        return { ok: false, errorFa: "فقط کاربران پشتیبان یا مدیر قابل اختصاص هستند." };
      }
      data.assignedToId = supporter.id;
      meta.assignedToId = supporter.id;
    }
  }

  if (input.priority !== undefined) {
    const validPriorities: TicketPriority[] = ["low", "normal", "high", "urgent"];
    if (!validPriorities.includes(input.priority)) {
      return { ok: false, errorFa: "اولویت نامعتبر است." };
    }
    data.priority = input.priority;
    meta.priority = input.priority;
  }

  if (Object.keys(data).length === 0) return { ok: true };

  await db.ticket.update({ where: { id: input.ticketId }, data });

  await audit({
    userId: input.adminId,
    actor: "admin",
    action: "ticket_assigned",
    targetType: "ticket",
    targetId: input.ticketId,
    ip: input.ip,
    meta,
  });

  // Notify the supporter if just assigned
  if (typeof meta.assignedToId === "string" && meta.assignedToId !== input.adminId) {
    await notify({
      userId: meta.assignedToId as string,
      category: "ticket",
      titleFa: "تیکت جدید به شما اختصاص یافت",
      bodyFa: `تیکت «${ticket.subject}» به شما اختصاص یافت.`,
      link: "/dashboard/tickets",
    });
  }

  return { ok: true };
}

// =====================================================================
// ATTACHMENTS — reply with image/zip files
// =====================================================================
const ATTACHMENT_ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ATTACHMENT_ALLOWED_ZIP_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
]);
const ATTACHMENT_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB
const ATTACHMENT_MAX_ZIP_BYTES = 10 * 1024 * 1024; // 10 MiB
const ATTACHMENT_MAX_FILES = 8;

export interface AttachmentValidationResult {
  ok: boolean;
  errorFa?: string;
  mime?: string;
  isImage?: boolean;
}

export function validateAttachmentMime(mime: string, originalName: string): AttachmentValidationResult {
  const lower = (mime || "").toLowerCase();
  const ext = (originalName || "").toLowerCase().split(".").pop() ?? "";
  if (ATTACHMENT_ALLOWED_IMAGE_MIMES.has(lower)) {
    return { ok: true, mime: lower, isImage: true };
  }
  if (ATTACHMENT_ALLOWED_ZIP_MIMES.has(lower) || (ext === "zip" && lower === "application/octet-stream")) {
    return { ok: true, mime: "application/zip", isImage: false };
  }
  // Fallback: sniff by extension for clients that send generic mime
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    const extToMime: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    return { ok: true, mime: extToMime[ext] ?? lower, isImage: true };
  }
  if (ext === "zip") {
    return { ok: true, mime: "application/zip", isImage: false };
  }
  return {
    ok: false,
    errorFa: `نوع فایل «${mime || ext || "ناشناخته"}» پشتیبانی نمی‌شود. فقط تصاویر (JPG/PNG/GIF/WebP) و فایل فشرده ZIP مجاز است.`,
  };
}

export function validateAttachmentSize(mime: string, sizeBytes: number): AttachmentValidationResult {
  if (mime.startsWith("image/")) {
    if (sizeBytes > ATTACHMENT_MAX_IMAGE_BYTES) {
      return { ok: false, errorFa: "حجم تصویر نباید بیشتر از ۵ مگابایت باشد." };
    }
    return { ok: true, mime, isImage: true };
  }
  if (mime === "application/zip") {
    if (sizeBytes > ATTACHMENT_MAX_ZIP_BYTES) {
      return { ok: false, errorFa: "حجم فایل ZIP نباید بیشتر از ۱۰ مگابایت باشد." };
    }
    return { ok: true, mime, isImage: false };
  }
  return { ok: false, errorFa: "نوع فایل پشتیبانی نمی‌شود." };
}

export interface ReplyAttachmentInput {
  fileName: string;
  mime: string;
  sizeBytes: number;
  buffer: Buffer;
}

export interface ReplyAttachmentResult {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

export async function replyTicketWithAttachments(input: {
  ticketId: string;
  userId: string;
  body: string;
  isStaff?: boolean;
  attachments?: ReplyAttachmentInput[];
  ip?: string;
}): Promise<{
  ok: boolean;
  reply?: TicketReplyView;
  errorFa?: string;
}> {
  const body = (input.body ?? "").trim();
  if (body.length < 2) return { ok: false, errorFa: "متن پاسخ حداقل باید ۲ نویسه باشد." };
  const attachments = input.attachments ?? [];
  if (attachments.length > ATTACHMENT_MAX_FILES) {
    return { ok: false, errorFa: `حداکثر ${toFaNumber(ATTACHMENT_MAX_FILES)} فایل در هر پاسخ مجاز است.` };
  }

  // Pre-validate all attachments (MIME + size) before touching the DB.
  for (const a of attachments) {
    const mimeCheck = validateAttachmentMime(a.mime, a.fileName);
    if (!mimeCheck.ok || !mimeCheck.mime) {
      return { ok: false, errorFa: mimeCheck.errorFa ?? "نوع فایل نامعتبر است." };
    }
    const sizeCheck = validateAttachmentSize(mimeCheck.mime, a.sizeBytes);
    if (!sizeCheck.ok) {
      return { ok: false, errorFa: sizeCheck.errorFa ?? "حجم فایل نامعتبر است." };
    }
    if (a.buffer.byteLength === 0) {
      return { ok: false, errorFa: "فایل خالی است." };
    }
  }

  const ticket = await db.ticket.findUnique({
    where: { id: input.ticketId },
    include: { user: { select: { id: true, email: true, mobile: true, firstName: true, lastName: true } } },
  });
  if (!ticket) return { ok: false, errorFa: "تیکت یافت نشد." };

  // Ownership enforcement: owner OR staff (role support/admin) can reply.
  if (input.isStaff !== true && ticket.userId !== input.userId) {
    return { ok: false, errorFa: "دسترسی غیرمجاز." };
  }
  if (ticket.status === "closed") {
    return { ok: false, errorFa: "تیکت بسته شده است." };
  }

  // Create the reply row first, then write files, then create attachment rows.
  const reply = await db.ticketReply.create({
    data: {
      ticketId: input.ticketId,
      userId: input.userId,
      body: body.slice(0, 8000),
      isStaff: input.isStaff === true,
    },
    include: { user: { select: { firstName: true, lastName: true, role: true } } },
  });

  const storedAttachments: ReplyAttachmentResult[] = [];
  try {
    const dir = await ensureTicketStorage(input.ticketId);
    for (const a of attachments) {
      const mimeCheck = validateAttachmentMime(a.mime, a.fileName);
      const finalMime = mimeCheck.mime ?? a.mime;
      // Sanitize filename — keep extension, randomize basename.
      const safeExt = (a.fileName.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
      const safeBase = a.fileName
        .replace(/\.[^.]+$/, "")
        .slice(0, 60)
        .replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        || "file";
      const uuid = crypto.randomBytes(8).toString("hex");
      const fileNameOnDisk = `${uuid}-${safeBase}.${safeExt}`;
      const absolutePath = path.join(dir, fileNameOnDisk);
      await fs.writeFile(absolutePath, a.buffer);
      // Storage path is RELATIVE to STORAGE_ROOT — used by the read route.
      const storagePath = path.join("tickets", input.ticketId, fileNameOnDisk);
      const created = await db.ticketAttachment.create({
        data: {
          replyId: reply.id,
          fileName: a.fileName.slice(0, 200),
          mime: finalMime,
          sizeBytes: a.buffer.byteLength,
          storagePath,
        },
      });
      storedAttachments.push({
        id: created.id,
        fileName: created.fileName,
        mime: created.mime,
        sizeBytes: created.sizeBytes,
      });
    }
  } catch (err) {
    // Best-effort cleanup of the half-written reply + attachments.
    try {
      await db.ticketReply.delete({ where: { id: reply.id } });
    } catch { /* ignore */ }
    // Generic client message — filesystem error text can leak absolute
    // paths (audit §34). Log server-side instead.
    console.error("ticket attachment save failed:", err instanceof Error ? err.message : err);
    return { ok: false, errorFa: "ذخیره فایل ناموفق بود. لطفاً دوباره تلاش کنید." };
  }

  // Update ticket status
  const newStatus: TicketStatus = input.isStaff ? "answered" : "open";
  await db.ticket.update({
    where: { id: input.ticketId },
    data: { status: newStatus },
  });

  await audit({
    userId: input.userId,
    actor: input.isStaff ? "support" : "user",
    action: "ticket_reply",
    targetType: "ticket",
    targetId: input.ticketId,
    ip: input.ip,
    meta: { isStaff: input.isStaff === true, attachmentCount: storedAttachments.length },
  });

  // Notify the OTHER party
  const recipientId = input.isStaff ? ticket.userId : (ticket.assignedToId ?? null);
  if (recipientId && recipientId !== input.userId) {
    await notify({
      userId: recipientId,
      category: "ticket",
      titleFa: `پاسخ تیکت: ${ticket.subject}`,
      bodyFa: `یک پاسخ جدید روی تیکت «${ticket.subject}» ثبت شد.`,
      link: "/dashboard/tickets",
      email: ticket.user?.email ? { to: ticket.user.email } : null,
    });
  }

  return {
    ok: true,
    reply: {
      id: reply.id,
      body: reply.body,
      isStaff: reply.isStaff,
      authorNameFa: userFullName(reply.user),
      createdAt: reply.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(reply.createdAt, { withTime: true }),
      attachments: storedAttachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        createdAt: reply.createdAt.toISOString(),
        createdAtFa: formatJalaliDateTime(reply.createdAt, { withTime: true }),
      })),
    },
  };
}

// ---------------------------------------------------------------------
// Download helper — fetch a single attachment for an authorized requester.
// ---------------------------------------------------------------------
export async function getAttachmentForDownload(input: {
  attachmentId: string;
  userId: string;
  isStaff: boolean;
}): Promise<
  | { ok: true; storagePath: string; mime: string; fileName: string; ticketId: string }
  | { ok: false; errorFa: string }
> {
  const att = await db.ticketAttachment.findUnique({
    where: { id: input.attachmentId },
    include: {
      reply: {
        select: {
          id: true,
          ticketId: true,
          ticket: { select: { id: true, userId: true } },
        },
      },
    },
  });
  if (!att) return { ok: false, errorFa: "فایل یافت نشد." };
  if (!att.reply?.ticket) return { ok: false, errorFa: "تیکت یافت نشد." };
  if (!input.isStaff && att.reply.ticket.userId !== input.userId) {
    return { ok: false, errorFa: "دسترسی غیرمجاز." };
  }
  return {
    ok: true,
    storagePath: att.storagePath,
    mime: att.mime,
    fileName: att.fileName,
    ticketId: att.reply.ticket.id,
  };
}

// Persian number helper for inline error messages.
function toFaNumber(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] ?? d);
}
