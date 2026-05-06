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
  "vaccine",
  "send_out",
  "consultation",
  "procedure",
  "home_service",
] as const;
export type ServiceSection = (typeof ALL_SECTIONS)[number];

// Per-role list of sections each "lab worker" handles in the queue.
// `null` means no section restriction (admin/pathologist see everything).
//
// medtech owns the lab bench: chemistry, hematology, immunology,
// urinalysis, microbiology, plus send-outs and ultrasounds (kept on the
// medtech side until/unless a sonographer role is split off).
//
// xray_technician owns x-ray imaging only.
//
// reception is intentionally excluded — they never see the lab queue.
const SECTIONS_BY_ROLE: Record<StaffSession["role"], ServiceSection[] | null> = {
  reception: [],
  medtech: [
    "chemistry",
    "hematology",
    "immunology",
    "urinalysis",
    "microbiology",
    "imaging_ultrasound",
    "send_out",
  ],
  xray_technician: ["imaging_xray"],
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
    case "reception":
      return "Queue";
  }
}
