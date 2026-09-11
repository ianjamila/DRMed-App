import type { ServiceSection } from "./role-sections";

// Pure predicate behind the N1 fix (2026-09): does a caller whose role
// resolves to `allowedSections` (the output of sectionsForRole) have access
// to a resource whose service section is `section`?
//
//   allowedSections === null  → unrestricted (admin/pathologist) — always true.
//   allowedSections === []    → deny-all (reception) — always false, even
//                                when `section` itself is null.
//   otherwise                 → `section` must be non-null AND a member of
//                                allowedSections.
//
// This mirrors the inline checks already used by
// src/lib/visits/bulk-selection.ts (scopeToAllowedSections), the queue list,
// the visit page, and the staff result-PDF route
// (src/app/(staff)/staff/(dashboard)/results/[testRequestId]/pdf/route.ts) —
// extracted here so a single-resource gate (one test_request, not a list)
// has one pure, unit-tested place to live instead of being re-derived per
// call site. No DB / no RSC import — safe to unit test directly.
export function isSectionAllowed(
  allowedSections: readonly ServiceSection[] | null,
  section: string | null | undefined,
): boolean {
  if (allowedSections === null) return true;
  if (allowedSections.length === 0) return false;
  return section != null && allowedSections.includes(section as ServiceSection);
}
