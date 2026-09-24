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
  schedule: {
    lead: "Service agreement (required).",
    body: "I consent to drmed.ph processing my contact details to fulfil this booking under the Philippine Data Privacy Act (RA 10173). Lab results are released only after payment.",
  },
};

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
