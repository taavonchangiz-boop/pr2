// POSTYAR — GET /api/media/[id] — auth-gated stream
// Verifies ownership (or admin role) before streaming the stored file.
// The file lives under /storage, NEVER in the public web root.
//
// Signed provider access (audit §21): external providers (Telegram/Bale)
// fetch published media by URL and CANNOT hold a user session. The publish
// worker therefore embeds a SHORT-LIVED HMAC token scoped to exactly this
// media id (`?exp=<unix>&sig=<hmac>`). The token is not permanent, not
// guessable, and expires quickly. Storage is never made public and the
// session requirement is never dropped — both prohibited by the audit
// rules.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/server/auth";
import { readPrivateFile } from "@/lib/storage";
import { verifyMediaUrlToken } from "@/lib/security/crypto";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;

  // Access path 1: authenticated owner/admin (session cookie).
  // Access path 2: valid short-lived signed token for THIS media id.
  let authorized = false;
  let sessionUser: Awaited<ReturnType<typeof requireUser>> | null = null;
  try {
    sessionUser = await requireUser();
    authorized = true;
  } catch {
    authorized = false;
  }

  const url = new URL(req.url);
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  const tokenOk = verifyMediaUrlToken(id, exp, sig);
  if (!authorized && !tokenOk) {
    return NextResponse.json(
      { errorFa: "نیاز به ورود" },
      { status: 401 },
    );
  }

  const media = await db.media.findUnique({ where: { id } });
  if (!media) {
    return NextResponse.json({ errorFa: "رسانه یافت نشد." }, { status: 404 });
  }
  // Owner or admin — session path only. The signed-token path is already
  // scoped to this exact media id by the HMAC, so no ownership check is
  // needed (possession of a fresh signed token implies the server issued
  // it for this media).
  if (sessionUser && media.ownerId !== sessionUser.id && sessionUser.role !== "admin") {
    return NextResponse.json({ errorFa: "دسترسی غیرمجاز." }, { status: 403 });
  }
  try {
    const buf = await readPrivateFile(media.storagePath);
    const safeName = encodeURIComponent(media.publicId);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": media.mime || "application/octet-stream",
        "content-length": String(buf.byteLength),
        "content-disposition": `inline; filename="${safeName}"; filename*=UTF-8''${safeName}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  } catch {
    return NextResponse.json({ errorFa: "فایل یافت نشد." }, { status: 404 });
  }
}
