import { sectionsForRole } from "@/lib/auth/role-sections";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { ServiceSection } from "@/lib/auth/role-sections";

/**
 * Two different questions about a visit's bill line, deliberately kept apart:
 *
 *   canSeeLine()      — may this role see the line at all (name, code,
 *                        price, discount, status)?
 *   canActOnResult()  — may this role act on the RESULT behind the line
 *                        (mark done, release, undo, open the bench page,
 *                        download the PDF)?
 *
 * Owner decision (2026-09-15) reverses the go-live "A4" rule. Under A4,
 * `sectionsForRole("reception") === []` was read as a blanket DENY on the
 * whole row, so reception saw no test lines at all. That was wrong: the front
 * desk enters every line at intake, prices it, and collects the bill for it —
 * it just never sees the *result*. So `canSeeLine` special-cases reception to
 * always true, while `canActOnResult` keeps A4's exact semantics unchanged
 * (built straight on `sectionsForRole`, reception denied).
 *
 * `sectionsForRole(role) === []` is still a DENY here, never "no filter" —
 * see the repo-wide rule in CLAUDE.md. It only changes what it's a deny FOR:
 * acting on results, not seeing the line.
 */

function sectionAllowed(
  allowedSections: readonly ServiceSection[] | null,
  section: string | null | undefined,
): boolean {
  if (allowedSections === null) return true; // unrestricted (admin/pathologist)
  if (allowedSections.length === 0) return false; // deny (reception)
  return section != null && allowedSections.includes(section as ServiceSection);
}

/**
 * May this role SEE the bill line (name, code, price, discount, status)?
 * Reception always can — the counter enters and collects the bill. Admin and
 * pathologist see everything (`sectionsForRole` is `null`). medtech and
 * xray_technician see only their own sections, same as today.
 */
export function canSeeLine(
  role: StaffSession["role"],
  section: string | null | undefined,
): boolean {
  if (role === "reception") return true;
  return sectionAllowed(sectionsForRole(role), section);
}

/**
 * May this role ACT on the result behind the line (mark done, release, undo,
 * open the bench page, download the PDF)? Unchanged from the pre-split
 * `isVisible` gate: built directly on `sectionsForRole`, so reception is
 * denied ([] = deny) and medtech/xray_technician are limited to their own
 * sections.
 */
export function canActOnResult(
  role: StaffSession["role"],
  section: string | null | undefined,
): boolean {
  return sectionAllowed(sectionsForRole(role), section);
}

/**
 * Page-level (not per-row) version of `canActOnResult`, for controls that
 * aren't tied to one line's section — e.g. the bulk-action bar, which acts on
 * whatever the operator has selected across sections. `sectionsForRole(role)
 * === []` still means denied, so this is false for reception and true for
 * every other role (admin/pathologist unrestricted; medtech/xray_technician
 * can act on *something*, just not everything, which the per-row gate above
 * still enforces on the actual selection).
 */
export function roleCanActOnResults(role: StaffSession["role"]): boolean {
  const allowed = sectionsForRole(role);
  return allowed === null || allowed.length > 0;
}
