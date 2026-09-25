import type { StaffSession } from "./require-staff";

// Service sections (mirrors PublicService.section in lib/marketing/services.ts).
// Kept here as plain strings so this module has no cross-dependency on the
// marketing types.
export const ALL_SECTIONS = [
  "package",
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "imaging_xray",
  "imaging_ultrasound",
  "imaging_ecg",
  "vaccine",
  "send_out",
  "consultation",
  "procedure",
  "home_service",
] as const;
export type ServiceSection = (typeof ALL_SECTIONS)[number];

// The sections that hold doctor work rather than lab work. `test_requests`
// doubles as the visit's bill line, so consultations and procedures are filed
// in it alongside lab tests (0090) — a report that means "lab" has to drop
// them, and dropping them leaves these two section options matching nothing.
//
// Enumerated, never allow-listed, for the same reason `classifyKind` treats
// `lab` as the complement: a section seeded into the catalog later should show
// up on the lab surfaces by default rather than silently vanish from them.
export const DOCTOR_SECTIONS: readonly ServiceSection[] = [
  "consultation",
  "procedure",
];

/** `ALL_SECTIONS` minus the doctor sections — the lab-only section vocabulary. */
export const LAB_SECTIONS: readonly ServiceSection[] = ALL_SECTIONS.filter(
  (s) => !DOCTOR_SECTIONS.includes(s),
);

// Per-role list of sections each "lab worker" handles in the queue.
// `null` means no section restriction (admin/pathologist see everything).
//
// medtech owns the lab bench: chemistry, hematology, immunology,
// urinalysis, microbiology, plus send-outs.
//
// xray_technician owns all imaging: x-ray AND ultrasound.
//
// reception is intentionally excluded — they never see the lab queue.
// Exported (read-only use) so result-edit-migration.test.ts can pin
// lab_sections_for_role() in migration 0172 to this table without
// re-deriving it.
export const SECTIONS_BY_ROLE: Record<StaffSession["role"], ServiceSection[] | null> = {
  reception: [],
  medtech: [
    "chemistry",
    "hematology",
    "immunology",
    "urinalysis",
    "microbiology",
    "send_out",
  ],
  xray_technician: ["imaging_xray", "imaging_ultrasound", "imaging_ecg"],
  pathologist: null,
  admin: null,
};

// Returns the sections this role can act on.
// `null` = unrestricted (admin/pathologist).
// `[]`   = no access (reception).
export function sectionsForRole(
  role: StaffSession["role"],
): ServiceSection[] | null {
  return SECTIONS_BY_ROLE[role];
}

// Sections whose bench work only ONE role may hold, even over the roles that
// are otherwise unrestricted. An x-ray exposure is taken by a licensed
// radiologic technologist, so an admin or pathologist who can see the imaging
// queue still cannot claim an x-ray into their own name (owner decision,
// 2026-09-24). Viewing, releasing and unclaiming are untouched — this narrows
// CLAIMING (and reassigning, which hands someone a claim) only.
//
// Ultrasound and ECG are deliberately absent: the rule was asked for x-ray.
const CLAIM_OWNER_BY_SECTION: Partial<
  Record<ServiceSection, StaffSession["role"]>
> = {
  imaging_xray: "xray_technician",
};

/** The one role allowed to claim this section's work, or null when any role
 *  that can see the section may claim it. */
export function claimOwnerRole(
  section: string | null | undefined,
): StaffSession["role"] | null {
  if (!section) return null;
  return CLAIM_OWNER_BY_SECTION[section as ServiceSection] ?? null;
}

/** Can a staff member in `role` hold a claim on work in `section`? Both gates
 *  must pass: the role's section scope (`[]` denies, `null` is unrestricted)
 *  and the section's single-owner rule. */
export function canClaimSection(
  role: StaffSession["role"],
  section: string | null | undefined,
): boolean {
  const allowed = sectionsForRole(role);
  if (allowed !== null) {
    if (!section || !allowed.includes(section as ServiceSection)) return false;
  }
  const owner = claimOwnerRole(section);
  return owner === null || owner === role;
}

/** Plain name of a claim-owner role, for "X-ray technician only" hints and
 *  refusal messages. */
export function claimOwnerLabel(role: StaffSession["role"]): string {
  return role === "xray_technician" ? "X-ray technician" : role.replace(/_/g, " ");
}

// Display label for a role used in headings, e.g. the queue page title.
export function queueTitleForRole(role: StaffSession["role"]): string {
  switch (role) {
    case "xray_technician":
      return "Imaging queue";
    case "medtech":
      return "Lab queue";
    case "pathologist":
    case "admin":
      return "Queue";
    // Reception only ever sees the "Released today" tab (owner decision
    // 2026-09-24), where it prints the patient's copy of a result.
    case "reception":
      return "Released results";
  }
}
