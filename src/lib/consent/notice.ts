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
