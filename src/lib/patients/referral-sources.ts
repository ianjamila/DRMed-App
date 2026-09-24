// Where a patient heard about the clinic — `patients.referral_source`, a
// foreign key to the `referral_sources` lookup seeded by migration 0055.
// Client-safe: the staff patient form's validation, the patient page, the
// Booking Sources report and the two public website forms (/schedule and
// /register) all read this one list.
//
// The ids and staff labels are pinned to 0055's seed by
// referral-sources.test.ts — a row added to the lookup needs adding here too,
// in the same PR, or the staff form offers a choice its validation rejects
// (which is exactly what happened to Instagram, TikTok, Returning patient and
// Gift code until 0158's PR).

export const REFERRAL_SOURCE_IDS = [
  "doctor_referral",
  "customer_referral",
  "online_facebook",
  "online_website",
  "online_google",
  "online_instagram",
  "online_tiktok",
  "walk_in",
  "returning_patient",
  "tenant_employee_northridge",
  "gift_code",
  "other",
] as const;

export type ReferralSourceId = (typeof REFERRAL_SOURCE_IDS)[number];

// Staff wording — identical to `referral_sources.label`, which the staff
// patient form and the patients list read from the database.
export const REFERRAL_SOURCE_LABEL: Record<ReferralSourceId, string> = {
  doctor_referral: "Doctor referral",
  customer_referral: "Customer referral",
  online_facebook: "Facebook",
  online_website: "Website",
  online_google: "Google",
  online_instagram: "Instagram",
  online_tiktok: "TikTok",
  walk_in: "Walk-in",
  returning_patient: "Returning patient",
  tenant_employee_northridge: "Northridge tenant / employee",
  gift_code: "Gift code",
  other: "Other",
};

// Patient wording for the public forms. Same ids, so an answer lands in the
// same bucket staff pick from at the counter.
export const PUBLIC_REFERRAL_SOURCE_LABEL: Record<ReferralSourceId, string> = {
  doctor_referral: "My doctor referred me",
  customer_referral: "A friend or family member",
  online_facebook: "Facebook / Messenger",
  online_website: "The DRMed website",
  online_google: "Google (search or Maps)",
  online_instagram: "Instagram",
  online_tiktok: "TikTok",
  walk_in: "I passed by the clinic",
  returning_patient: "I've been a DRMed patient before",
  tenant_employee_northridge: "I work at Northridge Plaza",
  gift_code: "A gift code",
  other: "Other / not sure",
};

export const PUBLIC_REFERRAL_QUESTION = "How did you hear about us?";
export const PUBLIC_REFERRAL_REQUIRED_ERROR = "Tell us how you heard about us.";

// The public forms' options, in the lookup's own sort order.
export const PUBLIC_REFERRAL_OPTIONS: ReadonlyArray<{ value: ReferralSourceId; label: string }> =
  REFERRAL_SOURCE_IDS.map((id) => ({ value: id, label: PUBLIC_REFERRAL_SOURCE_LABEL[id] }));

// Legacy imports and hand-entered rows predate the form question.
export const REFERRAL_NOT_RECORDED_LABEL = "Not recorded";

export function isReferralSource(value: unknown): value is ReferralSourceId {
  return typeof value === "string" && (REFERRAL_SOURCE_IDS as ReadonlyArray<string>).includes(value);
}

// Staff label for a stored value. An id this list does not know (a row added
// straight to the lookup) is shown raw rather than hidden; NULL is null so the
// caller picks its own "—" / "Not recorded".
export function referralSourceLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return isReferralSource(value) ? REFERRAL_SOURCE_LABEL[value] : value;
}
