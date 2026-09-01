// =====================================================================
// POSTYAR — Gold bot evaluation
// ---------------------------------------------------------------------
// `evalGoldBots` loads all enabled=true GoldBot rows; for each: fetch
// current price; if threshold crossed in configured direction since
// lastFiredAt: fire a Notification to the user AND optionally publish
// via Destination if destinationId is set; update lastFiredAt.
//
// Idempotent per bot per day — once a bot fires in a given Tehran day,
// it will not fire again until the next day (until threshold resets).
// =====================================================================
import { db } from "@/lib/db";
import { getGoldPrice, type GoldInstrument, instrumentFa } from "./index";
import { notify } from "@/lib/notifications";
import { getDestinationProvider } from "@/lib/providers";
import { formatRials, formatJalaliDateTime, toPersianDigits } from "@/lib/persian";

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min minimum between fires per bot

export interface GoldBotEvalResult {
  botId: string;
  fired: boolean;
  reason?: string;
}

/**
 * Evaluates all enabled gold bots. Returns the count of fires.
 * Designed to be called by a scheduler every N minutes (e.g., the
 * existing `src/lib/queue/scheduler.ts`).
 */
export async function evalGoldBots(): Promise<{ firedCount: number; results: GoldBotEvalResult[] }> {
  const bots = await db.goldBot.findMany({ where: { enabled: true }, take: 500 });
  const results: GoldBotEvalResult[] = [];
  let firedCount = 0;

  for (const bot of bots) {
    try {
      const r = await evalOneBot(bot);
      results.push(r);
      if (r.fired) firedCount += 1;
    } catch (e) {
      results.push({
        botId: bot.id,
        fired: false,
        reason: e instanceof Error ? e.message : "خطای ناشناخته",
      });
    }
  }

  return { firedCount, results };
}

// ---------------------------------------------------------------------
// Per-bot evaluation
// ---------------------------------------------------------------------
async function evalOneBot(bot: {
  id: string;
  userId: string;
  enabled: boolean;
  instrument: string;
  direction: string;
  thresholdPct: number;
  destinationId: string | null;
  lastFiredAt: Date | null;
}): Promise<GoldBotEvalResult> {
  const instrument = bot.instrument as GoldInstrument;
  const priceResult = await getGoldPrice(instrument);
  if (!priceResult.ok || priceResult.priceRials == null) {
    return { botId: bot.id, fired: false, reason: priceResult.errorFa ?? "قیمت در دسترس نیست." };
  }

  // Idempotent: don't fire more than once per Tehran day.
  const now = new Date();
  if (bot.lastFiredAt && now.getTime() - bot.lastFiredAt.getTime() < MIN_INTERVAL_MS) {
    return { botId: bot.id, fired: false, reason: "اخیراً فعال شده است." };
  }
  // Skip if same Tehran day and last fired today
  if (bot.lastFiredAt && isSameTehranDay(bot.lastFiredAt, now)) {
    return { botId: bot.id, fired: false, reason: "امروز فعال شده است." };
  }

  // Look up the last known baseline price (most recent GoldPrice row
  // BEFORE the lastFiredAt marker — that's the "since" baseline).
  const baselineRow = bot.lastFiredAt
    ? await db.goldPrice.findFirst({
        where: { instrument, fetchedAt: { lt: bot.lastFiredAt } },
        orderBy: { fetchedAt: "desc" },
      })
    : await db.goldPrice.findFirst({
        where: { instrument },
        orderBy: { fetchedAt: "desc" },
      });
  // If we have no baseline (no historical rows), we can't measure change.
  // Use the current price as a "starting baseline" by recording it
  // but NOT firing — then future runs can detect change.
  if (!baselineRow) {
    return { botId: bot.id, fired: false, reason: "بدون نقطه مرجع." };
  }

  const baseline = baselineRow.priceRials;
  if (baseline <= 0) {
    return { botId: bot.id, fired: false, reason: "نقطه مرجع نامعتبر." };
  }
  const current = priceResult.priceRials;
  const deltaPct = ((current - baseline) / baseline) * 100;
  const absPct = Math.abs(deltaPct);
  if (absPct < bot.thresholdPct) {
    return { botId: bot.id, fired: false, reason: `تغییر ${toPersianDigits(absPct.toFixed(2))}٪ کمتر از آستانه است.` };
  }

  // Direction check
  const direction = bot.direction ?? "both";
  if (direction === "up" && deltaPct <= 0) {
    return { botId: bot.id, fired: false, reason: "حرکت رو به بالا نبود." };
  }
  if (direction === "down" && deltaPct >= 0) {
    return { botId: bot.id, fired: false, reason: "حرکت رو به پایین نبود." };
  }

  // Threshold crossed in configured direction — FIRE!
  // ROOT-CAUSE FIX (audit G2 — fire race): claim the fire FIRST via a
  // conditional UPDATE (CAS on the previously-read lastFiredAt). Two
  // concurrent scheduler runs can no longer both pass the interval/day
  // checks and double-fire; the loser of the CAS reports not-fired.
  const claimed = await db.goldBot.updateMany({
    where: { id: bot.id, lastFiredAt: bot.lastFiredAt },
    data: { lastFiredAt: now },
  });
  if (claimed.count === 0) {
    return { botId: bot.id, fired: false, reason: "به‌تازگی توسط پردازش دیگر فعال شده است." };
  }
  const directionFa = deltaPct > 0 ? "صعودی" : "نزولی";
  const titleFa = `هشدار قیمت ${instrumentFa(instrument)}`;
  const bodyFa =
    `قیمت ${instrumentFa(instrument)} ${directionFa} ${toPersianDigits(absPct.toFixed(2))}٪ تغییر کرد.\n` +
    `قیمت فعلی: ${formatRials(current)}\n` +
    `قیمت مرجع: ${formatRials(baseline)}\n` +
    `زمان: ${formatJalaliDateTime(now, { withTime: true })}`;

  await notify({
    userId: bot.userId,
    category: "gold",
    titleFa,
    bodyFa,
    link: "/dashboard/gold",
  });

  // Optionally publish to destination if configured.
  if (bot.destinationId) {
    try {
      const dest = await db.destination.findUnique({ where: { id: bot.destinationId } });
      if (dest) {
        const provider = getDestinationProvider(dest.provider as "telegram" | "bale" | "rubika");
        const { decryptString } = await import("@/lib/security/crypto");
        const token = decryptString(dest.botTokenEnc);
        await provider.publishMessage({
          botToken: token,
          chatId: dest.chatId,
          text: `${titleFa}\n\n${bodyFa}`,
        });
      }
    } catch (err) {
      // Best-effort — the notification row is already written, but the
      // failure must never be SILENT: an uncertain/failed destination
      // publish is observable for debugging delivery issues.
      console.error(
        "gold bot destination publish failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { botId: bot.id, fired: true };
}

function isSameTehranDay(a: Date, b: Date): boolean {
  const offset = 3.5 * 60 * 60 * 1000;
  const aa = new Date(a.getTime() + offset);
  const bb = new Date(b.getTime() + offset);
  return aa.getUTCFullYear() === bb.getUTCFullYear()
    && aa.getUTCMonth() === bb.getUTCMonth()
    && aa.getUTCDate() === bb.getUTCDate();
}
