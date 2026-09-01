// POSTYAR — /api/admin/health (GET)
// Truthful health endpoint (addendum §5, §13 NO SHIM HIDING).
// Pings db, Redis (fresh PING), queue, storage, AI/gold/sms/email config
// presence. Reports the REAL active implementation for cache/lock/queue.
import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { refreshRedisLiveness, isRedisConnected } from "@/lib/security/cache";
import { pingRedis, getRedisUrlMasked, getRedisLastError } from "@/lib/security/redis-client";
import { listProviderStatus } from "@/lib/providers/ai";
import { getSetting } from "@/lib/providers/util";
import { maskToken } from "@/lib/persian";
import { formatJalaliDateTime } from "@/lib/persian";
import path from "node:path";
import fs from "node:fs";

type Status = "ok" | "warn" | "down";
interface Check { component: string; status: Status; message?: string; }

export async function GET() {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user;
  const checks: Check[] = [];

  // DB
  try {
    await db.$queryRaw`SELECT 1`;
    checks.push({ component: "db", status: "ok" });
  } catch (e) {
    checks.push({ component: "db", status: "down", message: e instanceof Error ? e.message : "خطای پایگاه داده" });
  }

  // Redis — fresh PING, truthful reporting
  const redisUrlConfigured = !!process.env.REDIS_URL?.trim();
  let redisLatency: number | null = null;
  try {
    redisLatency = await pingRedis();
  } catch {
    redisLatency = null;
  }
  await refreshRedisLiveness().catch(() => void 0);
  const redisLive = isRedisConnected();

  if (redisUrlConfigured && redisLive) {
    checks.push({
      component: "redis",
      status: "ok",
      message: `redis active (${redisLatency}ms) — ${getRedisUrlMasked()}`,
    });
  } else if (redisUrlConfigured && !redisLive) {
    // REDIS_URL is set but unreachable → DOWN, never silent shim
    checks.push({
      component: "redis",
      status: "down",
      message: getRedisLastError() ? `unreachable: ${getRedisLastError()}` : "unreachable (check REDIS_URL)",
    });
  } else {
    // No REDIS_URL configured → dev/sandbox memory shim (truthful)
    checks.push({
      component: "redis",
      status: "warn",
      message: "REDIS_URL not set — in-memory dev shim active (single-process only; NOT production-safe)",
    });
  }

  // Queue / lock — report the REAL backing implementation
  try {
    const { acquireLock, releaseLock } = await import("@/lib/security/cache");
    const holder = await acquireLock("health:probe", 5_000);
    if (holder) {
      await releaseLock("health:probe", holder);
      checks.push({
        component: "queue",
        status: redisLive ? "ok" : "warn",
        message: redisLive ? "redis-backed (distributed-safe)" : "memory-shim (single-process dev only)",
      });
    } else {
      checks.push({ component: "queue", status: "warn", message: "lock held" });
    }
  } catch (e) {
    checks.push({ component: "queue", status: "down", message: e instanceof Error ? e.message : "queue error" });
  }

  // Storage
  try {
    const storageDir = path.resolve(process.cwd(), "storage");
    if (fs.existsSync(storageDir)) {
      checks.push({ component: "storage", status: "ok", message: storageDir });
    } else {
      checks.push({ component: "storage", status: "warn", message: "storage dir missing" });
    }
  } catch (e) {
    checks.push({ component: "storage", status: "down", message: e instanceof Error ? e.message : "storage error" });
  }

  // AI providers
  try {
    const list = await listProviderStatus();
    const configuredCount = list.filter((p) => p.available).length;
    checks.push({
      component: "ai",
      status: configuredCount > 0 ? "ok" : "warn",
      message: `${configuredCount} از ${list.length} ارائه‌دهنده فعال (postyar-zai همیشه فعال است)`,
    });
  } catch (e) {
    checks.push({ component: "ai", status: "down", message: e instanceof Error ? e.message : "ai error" });
  }

  // Gold provider
  // V4 M-14 — same authoritative resolver as the runtime reader.
  const goldUrl = await getSetting("POSTYAR_GOLD_PROVIDER_URL", "");
  checks.push({
    component: "gold",
    status: goldUrl ? "ok" : "warn",
    message: goldUrl ? maskToken(goldUrl) : "غیرفعال",
  });

  // SMS provider
  const smsProvider = await getSetting("POSTYAR_SMS_PROVIDER", "");
  checks.push({
    component: "sms",
    status: smsProvider ? "ok" : "warn",
    message: smsProvider || "غیرفعال",
  });

  // Email
  const smtpHost = process.env.POSTYAR_SMTP_HOST ?? "";
  checks.push({
    component: "email",
    status: smtpHost ? "ok" : "warn",
    message: smtpHost || "غیرفعال (dev preview)",
  });

  const overall: Status = checks.some((c) => c.status === "down") ? "down"
    : checks.some((c) => c.status === "warn") ? "warn" : "ok";

  // Persist a row
  try {
    await db.healthCheck.create({
      data: {
        component: "overall",
        status: overall,
        message: checks.map((c) => `${c.component}=${c.status}`).join(","),
        checkedAt: new Date(),
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    overall,
    checkedAtFa: formatJalaliDateTime(new Date(), { withTime: true }),
    checks,
  });
}
