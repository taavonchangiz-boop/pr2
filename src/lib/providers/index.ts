// =====================================================================
// POSTYAR — Destination provider abstraction
// ---------------------------------------------------------------------
// A Destination represents a chat (channel/group/user) reachable via
// one of the supported messenger Bot APIs: Telegram, Bale, Rubika.
// Each provider lives in its own folder and implements the
// DestinationProvider interface.
//
// Security rules:
//   - NEVER log bot tokens, chat IDs or callback payloads to stdout.
//   - Token-in-URL is unavoidable for Telegram/Bale (API design) — but
//     we must scrub the token from any `raw` payload before persisting
//     it to the database (audit logs, error logs, etc.).
//   - Always verify TLS — no toggle, no `rejectUnauthorized: false`.
//   - All user-facing error strings are Persian.
//
// The Bale provider here is the **Bale Bot API** (messaging), NOT the
// Bale Payment provider. The Bale Payment provider is owned by another
// agent and lives elsewhere.
// =====================================================================
import type { GlassButton } from "@/lib/types/glass-button";
import { sanitizeRaw, scrubTokenFromUrl } from "./util";

export type DestinationProviderName = "telegram" | "bale" | "rubika";

export interface VerifyArgs {
  botToken: string;
  chatId: string;
}

export interface PublishArgs {
  botToken: string;
  chatId: string;
  text: string;
  mediaUrl?: string | null;
  buttons?: GlassButton[];
  disableWebPreview?: boolean;
}

export interface ProviderCapabilities {
  inlineButtons: boolean;
  replyButtons: boolean;
  webPreview: boolean;
  media: boolean;
}

export interface DeliveryResult {
  ok: boolean;
  providerMessageId?: string;
  errorFa?: string;
  raw?: unknown; // sanitized
  /**
   * V5 H-04 — ambiguity flag for FAILED sends. true = the outcome is
   * UNKNOWN (timeout/abort/network error, or an HTTP 5xx): the message
   * may or may not have been delivered, so the caller must NEVER blindly
   * re-send it (duplicate risk) and must record it as `uncertain`.
   * false (or absent) = the provider definitively refused (e.g. HTTP 4xx):
   * the message was NOT sent and a retry is safe.
   * A successful send (ok: true) is never ambiguous.
   */
  ambiguous?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  errorFa?: string;
  raw?: unknown; // sanitized
}

export interface DestinationProvider {
  /** Validate the credentials by calling getMe; chatId optional check. */
  verifyCredentials(args: VerifyArgs): Promise<VerifyResult>;
  /** Send a message (with optional media + buttons) to the chat. */
  publishMessage(args: PublishArgs): Promise<DeliveryResult>;
  /** Convert GlassButton[] to provider-specific keyboard payload. */
  formatButtons(buttons: GlassButton[]): unknown;
  /** Provider capabilities for UI hinting. */
  capabilities(): ProviderCapabilities;
  /** Provider name. */
  name(): DestinationProviderName;
}

// Registry --------------------------------------------------------------

import { telegramProvider } from "./telegram";
import { baleProvider } from "./bale";
import { rubikaProvider } from "./rubika";

export function getDestinationProvider(name: DestinationProviderName): DestinationProvider {
  switch (name) {
    case "telegram": return telegramProvider;
    case "bale": return baleProvider;
    case "rubika": return rubikaProvider;
    default: {
      const _exhaustive: never = name;
      throw new Error(`پروایدر ناشناخته: ${String(_exhaustive)}`);
    }
  }
}

export function isValidProviderName(s: string): s is DestinationProviderName {
  return s === "telegram" || s === "bale" || s === "rubika";
}

export { sanitizeRaw, scrubTokenFromUrl };
