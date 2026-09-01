// =====================================================================
// POSTYAR — Inbound update classification shared by live webhook
// processing and durable recovery (V5 C-02 Hole 2).
// ---------------------------------------------------------------------
// The Bale payment/non-payment routing decision MUST be a single shared
// predicate: the previous recovery pass routed EVERY stored payload to
// the non-payment workflow dispatcher, so a payment event that failed to
// complete live was later re-processed as a message — firing message-kind
// workflows on payment updates and masking payment-handler failures at
// the event layer. Both the live route and recoverBotEvents now route
// through this one predicate, and the regression suite pins it.
// =====================================================================

/** True when a Bale update carries payment-bearing content. */
export function isBalePaymentUpdate(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  const u = update as {
    pre_checkout_query?: unknown;
    message?: { successful_payment?: unknown };
  };
  return !!(
    u.pre_checkout_query ||
    (u.message && u.message.successful_payment)
  );
}
