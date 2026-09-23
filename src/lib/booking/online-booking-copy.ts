// Client-safe copy + validation for the online-booking pause switch
// (booking_settings, migration 0153). No DB and no "server-only" so the admin
// form, the public notice, and vitest can all import it.
import { CONTACT } from "@/lib/marketing/site";

// Mirrors the booking_settings_paused_message_len CHECK in 0153.
export const PAUSED_MESSAGE_MAX = 400;

export interface OnlineBookingStatus {
  paused: boolean;
  // Optional admin-written note shown on the notice; null = built-in copy only.
  message: string | null;
}

// Returned by submitBookingAction when a booking arrives while paused — e.g. a
// form left open in a tab from before the switch was flipped.
export const BOOKING_PAUSED_ERROR =
  `Online booking is paused right now. Please contact our reception to book — ` +
  `call or text ${CONTACT.phone.mobile}, or call ${CONTACT.phone.landline}.`;

// Trim, and treat a blank note as "no note". Returns an error for an over-long
// note rather than silently truncating what the admin wrote.
export function normalizePausedMessage(
  raw: string | null | undefined,
): { ok: true; message: string | null } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: true, message: null };
  if (trimmed.length > PAUSED_MESSAGE_MAX) {
    return {
      ok: false,
      error: `Keep the note to ${PAUSED_MESSAGE_MAX} characters or fewer (it is ${trimmed.length}).`,
    };
  }
  return { ok: true, message: trimmed };
}
