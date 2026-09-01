// =====================================================================
// POSTYAR — Referral engine
// ---------------------------------------------------------------------
// Atomic + idempotent referral reward posting. Prevents self-referral
// and duplicate rewards per referred user (ReferralReward.referredId UNIQUE).
// Money: INTEGER Rial. NO floats. Reward = min(REWARD_PERCENT%, CAP_RIALS).
// Persian error strings.
// =====================================================================
import { db } from "@/lib/db";
import { latestBalanceFor } from "@/lib/payments/wallet";
import { audit } from "@/lib/server/auth";
import { maskMobile, formatRials, toPersianDigits } from "@/lib/persian";

const DEFAULT_REWARD_PERCENT = 20; // % of paid amount
const DEFAULT_REWARD_CAP_RIALS = 100_000; // 10,000 toman

function rewardPercent(): number {
  const v = Number(process.env.POSTYAR_REFERRAL_PERCENT ?? DEFAULT_REWARD_PERCENT);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_REWARD_PERCENT;
}
function rewardCapRials(): number {
  const v = Number(process.env.POSTYAR_REFERRAL_CAP_RIALS ?? DEFAULT_REWARD_CAP_RIALS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_REWARD_CAP_RIALS;
}

export interface ReferralReferredItem {
  maskedEmail: string;
  maskedMobile: string;
  /** Referred user's full name (firstName + " " + lastName) — empty string if absent. */
  fullName: string;
  /** Referred user's account status: "active" | "suspended" | … */
  status: string;
  /** Referral reward status if a paid reward exists; null when no reward has been paid yet. */
  rewardStatus: string | null;
  amountRials: number;
  amountFa: string;
  /** When the referred user signed up (ISO). */
  createdAt: string;
  /** When the reward was paid (ISO), if any. */
  rewardCreatedAt: string | null;
}

export interface ReferralStats {
  referralCode: string;
  /** Count of Users where referredById === currentUser.id (regardless of reward status). */
  referredCount: number;
  /** Backward-compat alias: count of PAID referral rewards for the current user. */
  totalReferrals: number;
  totalRewardRials: number;
  totalRewardFa: string;
  referred: ReferralReferredItem[];
}

function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email;
  const [u, d] = email.split("@");
  if (!u || !d) return email;
  if (u.length <= 2) return `${u[0]?.[0] ?? ""}***@${d}`;
  return `${u[0]}***@${d}`;
}

export async function getMyReferralStats(userId: string): Promise<ReferralStats> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (!user) throw new Error("کاربر یافت نشد.");

  // ----- All referral rewards paid to this user (referrer) -----
  const rewards = await db.referralReward.findMany({
    where: { referrerId: userId, status: "paid" },
    orderBy: { createdAt: "desc" },
  });
  const rewardByReferredId = new Map(rewards.map((r) => [r.referredId, r]));
  let totalReward = 0;
  for (const r of rewards) totalReward += r.amountRials;

  // ----- Referred users (User where referredById === userId) -----
  // Counted regardless of reward status. Listed recent-first (max 50).
  const referredCount = await db.user.count({ where: { referredById: userId } });
  const referredUsers = referredCount > 0
    ? await db.user.findMany({
        where: { referredById: userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          email: true,
          mobile: true,
          firstName: true,
          lastName: true,
          status: true,
          createdAt: true,
        },
      })
    : [];

  const items: ReferralReferredItem[] = referredUsers.map((u) => {
    const reward = rewardByReferredId.get(u.id);
    const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    return {
      maskedEmail: maskEmail(u.email ?? ""),
      maskedMobile: maskMobile(u.mobile ?? ""),
      fullName,
      status: u.status,
      rewardStatus: reward?.status ?? null,
      amountRials: reward?.amountRials ?? 0,
      amountFa: formatRials(reward?.amountRials ?? 0),
      createdAt: u.createdAt.toISOString(),
      rewardCreatedAt: reward?.createdAt.toISOString() ?? null,
    };
  });

  return {
    referralCode: user.referralCode,
    referredCount,
    totalReferrals: rewards.length,
    totalRewardRials: totalReward,
    totalRewardFa: formatRials(totalReward),
    referred: items,
  };
}

export async function getRewardForNewActiveSubscription(input: {
  newUserId: string;
  referrerId: string;
  amountRials: number;
  idempotencyKey: string;
}): Promise<{ rewardRials: number; paid: boolean }> {
  // Self-referral guard
  if (input.newUserId === input.referrerId) {
    return { rewardRials: 0, paid: false };
  }
  // Validate money
  if (!Number.isInteger(input.amountRials) || input.amountRials <= 0) {
    return { rewardRials: 0, paid: false };
  }
  // Compute reward: min(REWARD_PERCENT% of paid, CAP_RIALS)
  const pct = rewardPercent();
  const cap = rewardCapRials();
  const computed = Math.round((input.amountRials * pct) / 100);
  const rewardRials = Math.min(computed, cap);
  if (rewardRials <= 0) return { rewardRials: 0, paid: false };

  const refIdemKey = `referral:reward:${input.idempotencyKey}`;
  const refWalletIdemKey = `wallet:referral:${input.idempotencyKey}`;
  const refLedgerIdemKey = `ledger:referral:${input.idempotencyKey}`;

  try {
    const result = await db.$transaction(async (tx) => {
      // Serialize the referrer's wallet mutation FIRST — the user-row
      // write takes the DB write lock and pins the snapshot after it, so
      // the checkpoint read below can never observe a stale balance
      // (V4 H-6 snapshot ordering).
      await tx.user.update({ where: { id: input.referrerId }, data: { updatedAt: new Date() } });

      // Check for existing reward for this referred user (UNIQUE constraint)
      const existing = await tx.referralReward.findUnique({
        where: { referredId: input.newUserId },
      });
      if (existing) {
        return { alreadyPaid: true as const };
      }

      // V4 H-6 — O(1) checkpoint read of the referrer's balance.
      const running = await latestBalanceFor(tx, input.referrerId);
      const balanceAfter = running + rewardRials;

      await tx.referralReward.upsert({
        where: { idempotencyKey: refIdemKey },
        create: {
          referrerId: input.referrerId,
          referredId: input.newUserId,
          amountRials: rewardRials,
          status: "paid",
          idempotencyKey: refIdemKey,
        },
        update: {},
      });
      await tx.walletTxn.upsert({
        where: { idempotencyKey: refWalletIdemKey },
        create: {
          userId: input.referrerId,
          amountRials: rewardRials,
          direction: "credit",
          reason: "referral_reward",
          balanceAfter,
          idempotencyKey: refWalletIdemKey,
        },
        update: {},
      });
      await tx.ledgerEntry.upsert({
        where: { idempotencyKey: refLedgerIdemKey },
        create: {
          userId: input.referrerId,
          eventType: "referral_reward",
          amountRials: rewardRials,
          currency: "IRR",
          idempotencyKey: refLedgerIdemKey,
        },
        update: {},
      });
      await tx.notification.create({
        data: {
          userId: input.referrerId,
          category: "referral",
          titleFa: "پاداش معرفی دوستان",
          bodyFa: `به‌خاطر دعوت از دوستان شما، ${formatRials(rewardRials)} به کیف پولتان افزوده شد.`,
          link: "/dashboard/referral",
        },
      });
      return { alreadyPaid: false as const };
    });

    await audit({
      userId: input.referrerId,
      actor: "system",
      action: "referral_reward_paid",
      targetType: "referral",
      targetId: input.newUserId,
      meta: {
        amountRials: rewardRials,
        alreadyPaid: result.alreadyPaid,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { rewardRials, paid: !result.alreadyPaid };
  } catch (err) {
    // UNIQUE constraint failure on `referredId` is also "already paid".
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (msg && /unique|constraint|UNIQUE/i.test(msg)) {
      return { rewardRials: 0, paid: false };
    }
    throw err;
  }
}

export const REFERRAL_DEFAULTS = {
  percent: DEFAULT_REWARD_PERCENT,
  capRials: DEFAULT_REWARD_CAP_RIALS,
};

export function describeRewardPolicyFa(): string {
  return `پاداش معرفی برابر است با حداکثر ${toPersianDigits(rewardPercent())}٪ از مبلغ پرداختی دوست شما، تا سقف ${formatRials(rewardCapRials())} به ازای هر کاربر.`;
}
