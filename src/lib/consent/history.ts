// src/lib/consent/history.ts
//
// Plain-language wording for one patient_consents event, shared by the
// patient page's consent history and anything else that lists events.
// Pure (no server-only) so every method / form / scope combination is tested.
import { PUBLIC_FORM_LABEL, type ConsentSourceForm } from "./public-form-consent";

export interface ConsentHistoryEvent {
  id: string;
  event_type: string;
  method: string | null;
  created_at: string;
  signatory: string | null;
  signatory_name: string | null;
  signatory_relationship: string | null;
  artifact_path: string | null;
  reason: string | null;
  source_form: string | null;
  consent_scope: string;
  actor_kind: string;
  recorded_by: { full_name: string } | null;
}

export interface ConsentHistoryLine {
  /** What happened, e.g. "Signed on screen", "Withdrawn". */
  what: string;
  /** Qualifier shown after `what`, e.g. "does not count as consent". */
  note: string | null;
  /** Who signed or accepted, or null for a withdrawal. */
  signer: string | null;
  /** Who recorded it. */
  recordedBy: string;
  /** Whether a form can be viewed for this event. */
  viewable: boolean;
}

function formLabel(sourceForm: string | null): string {
  return sourceForm === "register" || sourceForm === "schedule"
    ? PUBLIC_FORM_LABEL[sourceForm as ConsentSourceForm]
    : "website form";
}

export function describeConsentEvent(e: ConsentHistoryEvent): ConsentHistoryLine {
  const recordedBy =
    e.actor_kind === "patient"
      ? "Patient, online"
      : (e.recorded_by?.full_name ?? "Staff (name not on file)");

  if (e.event_type !== "granted") {
    return {
      what: "Withdrawn",
      note: e.reason ? `Reason: ${e.reason}` : null,
      signer: null,
      recordedBy,
      viewable: false,
    };
  }

  let what: string;
  let note: string | null = null;
  switch (e.method) {
    case "onscreen_signature":
      what = "Signed on screen";
      break;
    case "paper_wet_signature":
      what = "Signed paper form";
      note = e.artifact_path ? "scan attached" : "no scan attached";
      break;
    case "portal_acceptance":
      what = "Accepted in the patient portal";
      break;
    case "self_registration":
      what = `Ticked the consent box on the ${formLabel(e.source_form)}`;
      break;
    default:
      what = "Consent recorded";
  }
  if (e.consent_scope === "booking_contact_only") {
    note = "contact details for the booking only — does not count as consent";
  }

  const name = e.signatory_name?.trim() || null;
  const signer =
    e.signatory === "guardian" || e.signatory === "representative"
      ? `${e.signatory === "guardian" ? "Guardian" : "Representative"}: ${name ?? "name not recorded"}${
          e.signatory_relationship ? ` (${e.signatory_relationship})` : ""
        }`
      : `Patient${name ? ` (${name})` : ""}`;

  return { what, note, signer, recordedBy, viewable: true };
}

/**
 * Whether the latest event (events[0], newest first) is a booking-only grant
 * (0162): the old online-booking tick, recorded but not consent on file — the
 * patient page tells reception to have the patient sign.
 */
export function latestIsBookingOnly(events: ConsentHistoryEvent[]): boolean {
  const latest = events[0];
  return latest?.event_type === "granted" && latest.consent_scope === "booking_contact_only";
}
