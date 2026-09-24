// src/lib/consent/public-form-consent.ts
//
// The consent checkboxes on the two public forms. Each form renders its
// wording from here, and the grant row stores the same text
// (patient_consents.accepted_statement, 0162), so what a patient ticked and
// what staff later see on the signed-form page cannot drift apart.
//
// These are NOT the clinic consent notice (src/lib/consent/notice.ts): the
// public forms show one line and link to the website Privacy Notice.
// Changing a wording here changes what future patients agree to — past
// grants keep the text stored on their own row.

export type ConsentSourceForm = "register" | "schedule";

export interface PublicFormConsentWording {
  /** Bold lead-in rendered before the statement, if any. */
  lead: string | null;
  /** The statement up to (not including) "See the Privacy Notice." */
  body: string;
}

export const PUBLIC_FORM_CONSENT: Record<ConsentSourceForm, PublicFormConsentWording> = {
  register: {
    lead: null,
    body: "I consent to drmed.ph processing my personal and health information for registration and care under the Philippine Data Privacy Act (RA 10173).",
  },
  // Since 0162 the booking form asks for the same consent as registration
  // (it creates the patient record too). Its original wording covered
  // contact details only — see LEGACY_BOOKING_CONTACT_ONLY_STATEMENT.
  schedule: {
    lead: "Service agreement (required).",
    body: "I consent to drmed.ph processing my personal and health information for registration and care under the Philippine Data Privacy Act (RA 10173). Lab results are released only after payment.",
  },
};

/**
 * What the booking form said from 2026-05-07 until 0162. It covered contact
 * details for the booking only — not health information or results — so 0162
 * marks grants carrying it consent_scope = 'booking_contact_only' and they no
 * longer count as consent on file. Frozen: 0162 backfilled this exact text.
 */
export const LEGACY_BOOKING_CONTACT_ONLY_STATEMENT =
  "Service agreement (required). I consent to drmed.ph processing my contact details to fulfil this booking under the Philippine Data Privacy Act (RA 10173). Lab results are released only after payment. See the Privacy Notice.";

/** Where the statement's "Privacy Notice" link points. */
export const PUBLIC_FORM_PRIVACY_HREF = "/privacy";

/** The full statement as the patient read it, stored on the grant row. */
export function publicFormConsentStatement(form: ConsentSourceForm): string {
  const { lead, body } = PUBLIC_FORM_CONSENT[form];
  return [lead, body, "See the Privacy Notice."].filter(Boolean).join(" ");
}

export const PUBLIC_FORM_LABEL: Record<ConsentSourceForm, string> = {
  register: "online registration form",
  schedule: "online booking form",
};
