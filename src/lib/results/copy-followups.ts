// Pure rules for corrected-result follow-ups (0179). No server-only, no IO.

/** One row of result_copy_state(). */
export interface CopyState {
  result_id: string;
  latest_amendment_id: string | null;
  amendment_count: number;
  amended_at: string | null;
  holds_copy: boolean;
  portal_outdated: boolean;
  printed_outdated: boolean;
  followed_up: boolean;
  notified_at: string | null;
  notify_failed: boolean;
  has_email: boolean;
  has_phone: boolean;
}

export type NotifyOffer = { offered: true } | { offered: false; reason: string };

/** The edit form offers "Let the patient know…" only when it can mean something. */
export function shouldOfferNotify(s: CopyState | undefined): NotifyOffer {
  if (!s) return { offered: false, reason: "Couldn't check whether the patient has a copy." };
  if (!s.holds_copy) {
    return { offered: false, reason: "The patient hasn't downloaded or been handed a copy yet." };
  }
  if (!s.has_email && !s.has_phone) {
    return { offered: false, reason: "No email or mobile number on file." };
  }
  return { offered: true };
}

export function copyKindLabel(s: { portal_outdated: boolean; printed_outdated: boolean }): string {
  if (s.portal_outdated && s.printed_outdated) return "Portal download + printed copy";
  return s.portal_outdated ? "Portal download" : "Printed copy";
}

const CHANNEL_WORD: Record<string, string> = { email: "email", sms: "SMS" };

export function followUpStatusLabel(s: {
  contacted_at: string | null;
  notified_at: string | null;
  notify_failed: boolean;
  notified_channels: readonly string[] | null;
}): string {
  if (s.contacted_at) return "Contacted";
  if (!s.notified_at) return "Not contacted";
  if (s.notify_failed) return "Send failed — call the patient";
  if (!s.notified_channels) return "Send status unknown — call the patient";
  if (s.notified_channels.length === 0) return "Send failed — call the patient";
  const words = s.notified_channels.map((c) => CHANNEL_WORD[c] ?? c);
  return `Notified by ${words.join(" and ")}`;
}

/** Visit-page chip text, or null when there is nothing to chase. */
export function outdatedCopyChip(s: CopyState | undefined): string | null {
  if (!s || s.followed_up || !(s.portal_outdated || s.printed_outdated)) return null;
  if (s.printed_outdated && !s.portal_outdated) {
    return "Patient has an older copy (printed) — reprint before handing over";
  }
  if (s.printed_outdated) return "Patient has an older copy (portal + printed) — reprint before handing over";
  return "Patient has an older copy (portal download)";
}

/** PostgREST's max_rows (supabase/config.toml). result_outdated_copies is a bare
 * RPC select, so a row count at (or past) this ceiling means rows may be
 * silently missing rather than "that's everyone". */
export const OUTDATED_COPIES_MAX_ROWS = 1000;

/** Whether a fetched row count could be hiding rows behind the PostgREST cap. */
export function isOutdatedCopiesCapped(rowCount: number): boolean {
  return rowCount >= OUTDATED_COPIES_MAX_ROWS;
}

/** Dashboard-card count: the exact number, or "1000+" once the cap may be hiding the true count. */
export function cappedCountLabel(count: number, capped: boolean): string | number {
  return capped ? `${OUTDATED_COPIES_MAX_ROWS}+` : count;
}

export const PATIENT_CONTACTED_ACTION = "result.patient_contacted";

/** What an edit form's notify outcome ("sent" | "failed" | "not_set_up" | "already" | "inactive" | "not_offered" | …) reads as. */
export const NOTIFY_OUTCOME_TEXT: Record<string, string> = {
  sent: " The patient was sent an update notice.",
  // X3: sent, but the follow-up record failed — the list may still show them.
  sent_unrecorded: " The patient was sent an update notice, but that couldn't be saved — Result follow-ups may still list them.",
  failed: " The patient notice could not be sent — they're on Result follow-ups.",
  // Every channel was skipped and at least one only because email/SMS
  // sending isn't configured here — not the patient's record at fault.
  not_set_up: " No patient notice was sent — email and text notices aren't set up here. They're on Result follow-ups.",
  already: " The patient was already notified about this correction.",
  inactive: " No patient notice was sent (the patient's record is no longer active).",
  not_offered: " No patient notice was sent (no copy or no contact on file).",
  // R1: undo-release walked the test back to ready_for_release/result_uploaded
  // between "download" and "correct" — the portal only serves released
  // results, so a notice would point the patient at a copy they can't open.
  not_released: " No patient notice was sent — the result isn't released, so the patient can't open it yet. They stay on Result follow-ups.",
  // R6: the copy-state read itself failed (RPC error, or no row — anomalous
  // right after a commit), so nothing is known about whether the patient
  // holds a copy or has contact on file. Never claim they're on Result
  // follow-ups here — that depends on holds_copy, which this outcome never
  // learned.
  check_failed: " Couldn't check whether the patient has a copy, so no notice was sent.",
};
