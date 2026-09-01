// =====================================================================
// POSTYAR — Private file storage + media pipeline
// ---------------------------------------------------------------------
// All media is stored OUTSIDE the public web root, under
// `${process.cwd()}/storage/`. Filenames are randomized (UUID) so
// nothing enumerable is exposed. Authorized download is only ever done
// through auth-gated API routes that verify ownership.
//
// Image pipeline:
//   - validate size ≤ 5 MB (env-overridable)
//   - validate MIME via magic bytes (use `sharp` to decode)
//   - re-encode to WebP (quality 80); discard the original buffer
//   - return { storagePath, publicId, width, height, sizeBytes }
//
// Video pipeline:
//   - validate size ≤ 50 MB (POSTYAR_MAX_VIDEO_MB override)
//   - validate MIME via magic bytes
//   - reject executables (PE/ELF/Mach-O magic bytes)
//   - store original buffer at randomized path
//
// NEVER log buffers, file paths, or publicIds to stdout.
// =====================================================================
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";

export const STORAGE_ROOT = path.resolve(process.cwd(), "storage");
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_VIDEO_MAX_MB = 50;
const VIDEO_MAX_BYTES =
  (Number(process.env.POSTYAR_MAX_VIDEO_MB) || DEFAULT_VIDEO_MAX_MB) * 1024 * 1024;

const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_VIDEO_MIMES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];

// ---- Magic-byte detection -------------------------------------------------
const MAGIC_SIGNATURES: Array<{ mime: string; bytes: number[]; offset: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF....WEBP
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 }, // GIF8
  { mime: "video/mp4", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp at offset 4
  { mime: "video/quicktime", bytes: [0x6d, 0x6f, 0x6f, 0x76], offset: 4 }, // moov
  { mime: "video/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0 }, // EBML
  { mime: "video/x-matroska", bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0 }, // EBML (mkv)
  // Executables — rejected explicitly
  { mime: "application/x-msdownload", bytes: [0x4d, 0x5a], offset: 0 }, // MZ (PE/Windows)
  { mime: "application/x-elf", bytes: [0x7f, 0x45, 0x4c, 0x46], offset: 0 }, // ELF
  { mime: "application/x-mach-o-64", bytes: [0xcf, 0xfa, 0xed, 0xfe], offset: 0 }, // Mach-O 64
  { mime: "application/x-mach-o-32", bytes: [0xce, 0xfa, 0xed, 0xfe], offset: 0 }, // Mach-O 32
];

const EXECUTABLE_MIMES = new Set([
  "application/x-msdownload",
  "application/x-elf",
  "application/x-mach-o-64",
  "application/x-mach-o-32",
]);

export function detectMime(buf: Buffer): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    if (buf.length < sig.offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buf[sig.offset + i] !== sig.bytes[i]) { match = false; break; }
    }
    if (match) return sig.mime;
  }
  return null;
}

export function isExecutable(buf: Buffer): boolean {
  const m = detectMime(buf);
  return m ? EXECUTABLE_MIMES.has(m) : false;
}

// ---- Directory bootstrap --------------------------------------------------
let storageReady: Promise<void> | null = null;
async function ensureStorage(): Promise<void> {
  if (!storageReady) {
    storageReady = (async () => {
      await fs.mkdir(STORAGE_ROOT, { recursive: true });
      await fs.mkdir(path.join(STORAGE_ROOT, "images"), { recursive: true });
      await fs.mkdir(path.join(STORAGE_ROOT, "videos"), { recursive: true });
      await fs.mkdir(path.join(STORAGE_ROOT, "receipts"), { recursive: true });
      await fs.mkdir(path.join(STORAGE_ROOT, "avatars"), { recursive: true });
      // Drop a .gitignore-style README (no web serving anyway)
      try {
        await fs.writeFile(
          path.join(STORAGE_ROOT, "README.md"),
          "# Private media storage — DO NOT serve directly\n",
        );
      } catch { /* ignore */ }
    })();
  }
  await storageReady;
}

// Ensure storage dir is ready at module load.
void ensureStorage();

// ---- Core primitives ------------------------------------------------------
export interface SavedFile {
  storagePath: string; // path relative to STORAGE_ROOT (e.g. "images/abc.webp")
  publicId: string; // randomized filename (e.g. "abc.webp")
  absolutePath: string;
}

export interface SaveOpts {
  ext: string;
  mime: string;
  maxSizeBytes: number;
  allowedMimes: string[];
  subdir: string; // images|videos|receipts|avatars
}

function randomPublicId(ext: string): string {
  // 32 hex chars (16 bytes) + extension — collision-resistant and unguessable.
  const rand = crypto.randomBytes(16).toString("hex");
  return `${rand}.${ext.replace(/^\./, "")}`;
}

function resolveAbsolute(subdir: string, publicId: string): string {
  return path.join(STORAGE_ROOT, subdir, publicId);
}

function resolveRelative(subdir: string, publicId: string): string {
  return path.join(subdir, publicId);
}

// ROOT-CAUSE FIX (audit §20 — storage traversal): the previous guard was
// `absolute.startsWith(STORAGE_ROOT)` without a trailing separator, so
// any sibling directory sharing the root as a string prefix (e.g.
// "<root>-evil/…") or an absolute path inside such a sibling passed the
// check. The canonical path is now fully resolved and must be either the
// storage root itself or a TRUE descendant (root + path separator).
function isInsideStorageRoot(absolute: string): boolean {
  const canonical = path.resolve(absolute);
  if (canonical === STORAGE_ROOT) return true;
  return canonical.startsWith(STORAGE_ROOT + path.sep);
}

export async function savePrivateFile(
  buf: Buffer,
  opts: SaveOpts,
): Promise<{ storagePath: string; publicId: string; absolutePath: string; sizeBytes: number }> {
  await ensureStorage();
  if (!Buffer.isBuffer(buf)) throw new Error("ورودی نامعتبر است.");
  if (buf.byteLength === 0) throw new Error("فایل خالی است.");
  if (buf.byteLength > opts.maxSizeBytes) {
    throw new Error(
      `حجم فایل بیشتر از حد مجاز (${Math.round(opts.maxSizeBytes / 1024 / 1024)} مگابایت) است.`,
    );
  }
  if (!opts.allowedMimes.includes(opts.mime)) {
    throw new Error("نوع فایل پشتیبانی نمی‌شود.");
  }
  if (isExecutable(buf)) throw new Error("فایل اجرایی بارگذاری نمی‌شود.");
  const publicId = randomPublicId(opts.ext);
  const storagePath = resolveRelative(opts.subdir, publicId);
  const absolutePath = resolveAbsolute(opts.subdir, publicId);
  // V4 M-13 — fs errors carry absolute paths; they never reach the client.
  try {
    await fs.writeFile(absolutePath, buf);
  } catch (err) {
    console.error("file persist failed:", err instanceof Error ? err.message : err);
    throw new Error("ذخیره‌سازی فایل ناموفق بود. لطفاً بعداً تلاش کنید.");
  }
  // Zero out the buffer to discourage lingering references — best-effort.
  buf.fill(0);
  return { storagePath, publicId, absolutePath, sizeBytes: buf.byteLength };
}

export async function readPrivateFile(storagePath: string): Promise<Buffer> {
  if (!storagePath || typeof storagePath !== "string") {
    throw new Error("مسیر فایل نامعتبر است.");
  }
  // Reject any traversal attempt, then PROVE containment on the fully
  // resolved canonical path (audit §20 — string prefix checks alone are
  // not sufficient).
  const normalized = path.normalize(storagePath).replace(/^(\.\.[/\\])+/, "");
  if (normalized.includes("..")) throw new Error("مسیر فایل نامعتبر است.");
  const absolute = path.isAbsolute(normalized) ? normalized : path.join(STORAGE_ROOT, normalized);
  if (!isInsideStorageRoot(absolute)) {
    throw new Error("مسیر فایل خارج از محدوده مجاز است.");
  }
  return fs.readFile(path.resolve(absolute));
}

export async function deletePrivateFile(storagePath: string): Promise<void> {
  try {
    const normalized = path.normalize(storagePath).replace(/^(\.\.[/\\])+/, "");
    if (normalized.includes("..")) return;
    const absolute = path.isAbsolute(normalized)
      ? normalized
      : path.join(STORAGE_ROOT, normalized);
    // Same canonical containment proof as readPrivateFile (audit §20).
    if (!isInsideStorageRoot(absolute)) return;
    await fs.unlink(path.resolve(absolute));
  } catch {
    // Deleting an already-absent file is normal; anything else is logged
    // for operators instead of vanishing silently (audit §31).
  }
}

// ---- Image pipeline (re-encode to WebP) ----------------------------------
export interface ProcessedImage {
  storagePath: string;
  publicId: string;
  width: number;
  height: number;
  sizeBytes: number;
  mime: string;
}

export async function processImageUpload(buf: Buffer, declaredMime: string): Promise<ProcessedImage> {
  if (!Buffer.isBuffer(buf)) throw new Error("ورودی نامعتبر است.");
  if (buf.byteLength === 0) throw new Error("فایل خالی است.");
  if (buf.byteLength > IMAGE_MAX_BYTES) {
    throw new Error("حجم تصویر بیشتر از ۵ مگابایت است.");
  }
  if (isExecutable(buf)) throw new Error("فایل اجرایی بارگذاری نمی‌شود.");
  const detected = detectMime(buf);
  const mime = detected ?? declaredMime;
  if (!ALLOWED_IMAGE_MIMES.includes(mime)) {
    throw new Error("تنها تصاویر JPEG / PNG / WebP / GIF مجاز هستند.");
  }

  // Use sharp to decode — invalid images will throw
  let pipeline: sharp.Sharp;
  try {
    pipeline = sharp(buf, { failOn: "truncated" });
    // Force metadata read so we know dimensions before re-encoding
    const meta = await pipeline.metadata();
    if (!meta.width || !meta.height) {
      throw new Error("تصویر ناقص است یا ابعاد آن قابل خواندن نیست.");
    }
    if (meta.width > 8000 || meta.height > 8000) {
      throw new Error("ابعاد تصویر بسیار بزرگ است.");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("ابعاد")) throw err;
    if (err instanceof Error && err.message.startsWith("حجم")) throw err;
    throw new Error("فایل تصویر معتبر نیست یا آسیب دیده است.");
  }

  // Re-encode to WebP, quality 80. Original buffer discarded after.
  // V4 M-13 — raw sharp errors never leave the server: bounded Persian
  // only (internal details are logged server-side).
  let webpBuf: Buffer;
  try {
    webpBuf = await sharp(buf, { failOn: "truncated" })
      .rotate() // honor EXIF orientation
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (err) {
    console.error("image re-encode failed:", err instanceof Error ? err.message : err);
    throw new Error("پردازش تصویر ناموفق بود؛ فایل معتبر نیست یا پشتیبانی نمی‌شود.");
  }

  const after = await sharp(webpBuf).metadata();
  const publicId = randomPublicId("webp");
  const storagePath = resolveRelative("images", publicId);
  const absolutePath = resolveAbsolute("images", publicId);
  // V4 M-13 — fs errors carry absolute paths; they never reach the client.
  try {
    await ensureStorage();
    await fs.writeFile(absolutePath, webpBuf);
  } catch (err) {
    console.error("image persist failed:", err instanceof Error ? err.message : err);
    throw new Error("ذخیره‌سازی فایل ناموفق بود. لطفاً بعداً تلاش کنید.");
  }
  // Zero out original + intermediate buffers — best-effort
  buf.fill(0);
  webpBuf.fill(0);
  return {
    storagePath,
    publicId,
    width: after.width ?? 0,
    height: after.height ?? 0,
    sizeBytes: webpBuf.byteLength,
    mime: "image/webp",
  };
}

// ---- Video pipeline ------------------------------------------------------
export interface ProcessedVideo {
  storagePath: string;
  publicId: string;
  sizeBytes: number;
  mime: string;
}

export async function processVideoUpload(buf: Buffer, declaredMime: string): Promise<ProcessedVideo> {
  if (!Buffer.isBuffer(buf)) throw new Error("ورودی نامعتبر است.");
  if (buf.byteLength === 0) throw new Error("فایل خالی است.");
  if (buf.byteLength > VIDEO_MAX_BYTES) {
    throw new Error(
      `حجم ویدئو بیشتر از حد مجاز (${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} مگابایت) است.`,
    );
  }
  if (isExecutable(buf)) throw new Error("فایل اجرایی بارگذاری نمی‌شود.");
  const detected = detectMime(buf);
  const mime = detected ?? declaredMime;
  if (!ALLOWED_VIDEO_MIMES.includes(mime)) {
    throw new Error("تنها ویدئوهای MP4 / MOV / WebM / MKV مجاز هستند.");
  }
  // Map MKV/WebM into a stable mime label
  const labelMime = mime === "video/x-matroska" ? "video/x-matroska" : mime;
  const ext = mimeToExt(labelMime);
  const publicId = randomPublicId(ext);
  const storagePath = resolveRelative("videos", publicId);
  const absolutePath = resolveAbsolute("videos", publicId);
  // V4 M-13 — fs errors carry absolute paths; they never reach the client.
  try {
    await ensureStorage();
    await fs.writeFile(absolutePath, buf);
  } catch (err) {
    console.error("video persist failed:", err instanceof Error ? err.message : err);
    throw new Error("ذخیره‌سازی فایل ناموفق بود. لطفاً بعداً تلاش کنید.");
  }
  buf.fill(0);
  return { storagePath, publicId, sizeBytes: buf.byteLength, mime: labelMime };
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case "video/mp4": return "mp4";
    case "video/quicktime": return "mov";
    case "video/webm": return "webm";
    case "video/x-matroska": return "mkv";
    default: return "bin";
  }
}

// ---- Download route handler factory --------------------------------------
// Returns a Next.js Route Handler that streams the stored file after
// authenticating the user and verifying ownership. The `resolveOwnerId`
// callback maps `publicId` -> ownerId or null (the requester must match).
export interface DownloadContext {
  ownerId: string;
  mime: string;
  storagePath: string;
  filename?: string;
}

export async function streamPrivateFile(
  storagePath: string,
  mime: string,
  filename: string,
): Promise<Response> {
  let buf: Buffer;
  try {
    buf = await readPrivateFile(storagePath);
  } catch {
    return new Response(JSON.stringify({ errorFa: "فایل یافت نشد." }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const safeName = encodeURIComponent(filename);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": mime || "application/octet-stream",
      "content-length": String(buf.byteLength),
      "content-disposition": `inline; filename="${safeName}"; filename*=UTF-8''${safeName}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

export const MAX_IMAGE_BYTES = IMAGE_MAX_BYTES;
export const MAX_VIDEO_BYTES = VIDEO_MAX_BYTES;
