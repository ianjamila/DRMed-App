// src/lib/consent/notice.ts
import { CONTACT, SITE } from "@/lib/marketing/site";

// Bump this date string whenever the notice wording materially changes.
// The agreed version is stored on every patient_consents grant row.
export const CURRENT_CONSENT_NOTICE_VERSION = "2026-05-29";

export interface ConsentNoticeSection {
  heading: string;
  body: string;
}

export const CONSENT_CONTROLLER = {
  name: SITE.name,
  address: `${CONTACT.address.line1}, ${CONTACT.address.line2}, ${CONTACT.address.city}`,
  mobile: CONTACT.phone.mobile,
  landline: CONTACT.phone.landline,
} as const;

export const CONSENT_NOTICE_SECTIONS: ConsentNoticeSection[] = [
  {
    heading: "1. Personal Information Controller",
    body: `${CONSENT_CONTROLLER.name}, ${CONSENT_CONTROLLER.address}. Mobile ${CONSENT_CONTROLLER.mobile}; Telephone ${CONSENT_CONTROLLER.landline}.`,
  },
  {
    heading: "2. Personal Data We Process",
    body: "Patient identification details; laboratory transaction information and released reports; and security metadata (timestamps, hashed client identifiers) for consent and access logging.",
  },
  {
    heading: "3. Purpose of Processing",
    body: "To verify your identity for secure release of test results; provide report access and status tracking; maintain service security, fraud prevention and audit records; and comply with legal, regulatory and medical-record obligations.",
  },
  {
    heading: "4. Data Sharing",
    body: "Your data may be processed by authorized service providers (secured cloud hosting, document storage, anti-bot protection) under confidentiality and data-protection controls. Your data is not sold to third parties.",
  },
  {
    heading: "5. Retention",
    body: "Data is retained only as long as necessary for medical, legal and operational purposes, and disposed of securely per DR Med retention schedules and legal requirements.",
  },
  {
    heading: "6. Your Rights & Withdrawal",
    body: "You have the right to be informed, to access, object, rectify, erase/block (where applicable), data portability, and to lodge a complaint. You may withdraw this consent at any time in person at reception; withdrawal does not affect processing already performed.",
  },
];

export const CONSENT_STATEMENT =
  "I have read and understood this notice and consent to DR Med Clinic and Laboratory processing my personal and health data for the purposes stated above.";

export interface ConsentNoticeText {
  sections: ConsentNoticeSection[];
  statement: string;
}

// The exact wording of every notice version a patient has agreed to, frozen
// as literal text. The live notice above is BUILT from CONTACT/SITE, so an
// address or phone change would silently rewrite what an old consent appears
// to say; the signed-form page (patients/[id]/consent/signed) renders from
// here instead, so each consent shows the words that were actually agreed to.
//
// When the wording (or the clinic's contact details) changes: bump
// CURRENT_CONSENT_NOTICE_VERSION and add the new text here under the new
// version — never edit an existing entry. notice.test.ts fails until the
// entry for the current version matches the live text.
//
// 2026-05-29 is frozen as it reads today. The only change since that date was
// cosmetic ("DRMed Clinic & Laboratory" → "and", 2026-06-18, #90).
export const CONSENT_NOTICE_ARCHIVE: Readonly<Record<string, ConsentNoticeText>> = {
  "2026-05-29": {
    sections: [
      {
        heading: "1. Personal Information Controller",
        body: "DRMed Clinic and Laboratory, 4/F DRMed Clinic and Laboratory, Northridge Plaza, Congressional Avenue, Quezon City. Mobile 0916 604 3208; Telephone (02) 8 355 3517.",
      },
      {
        heading: "2. Personal Data We Process",
        body: "Patient identification details; laboratory transaction information and released reports; and security metadata (timestamps, hashed client identifiers) for consent and access logging.",
      },
      {
        heading: "3. Purpose of Processing",
        body: "To verify your identity for secure release of test results; provide report access and status tracking; maintain service security, fraud prevention and audit records; and comply with legal, regulatory and medical-record obligations.",
      },
      {
        heading: "4. Data Sharing",
        body: "Your data may be processed by authorized service providers (secured cloud hosting, document storage, anti-bot protection) under confidentiality and data-protection controls. Your data is not sold to third parties.",
      },
      {
        heading: "5. Retention",
        body: "Data is retained only as long as necessary for medical, legal and operational purposes, and disposed of securely per DR Med retention schedules and legal requirements.",
      },
      {
        heading: "6. Your Rights & Withdrawal",
        body: "You have the right to be informed, to access, object, rectify, erase/block (where applicable), data portability, and to lodge a complaint. You may withdraw this consent at any time in person at reception; withdrawal does not affect processing already performed.",
      },
    ],
    statement:
      "I have read and understood this notice and consent to DR Med Clinic and Laboratory processing my personal and health data for the purposes stated above.",
  },
};

// The wording a given consent was agreed to, or null when that version's text
// was never archived (the caller then shows the current wording and says so).
export function consentNoticeText(version: string): ConsentNoticeText | null {
  return Object.hasOwn(CONSENT_NOTICE_ARCHIVE, version)
    ? CONSENT_NOTICE_ARCHIVE[version]
    : null;
}
