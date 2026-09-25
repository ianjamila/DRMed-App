import { sectionsForRole } from "@/lib/auth/role-sections";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { ServiceSection } from "@/lib/auth/role-sections";
import { isDoctorKind } from "./order-lines";
import { membersWithinSections } from "@/lib/results/report-section-gate";

/**
 * Two different questions about a visit's bill line, deliberately kept apart:
 *
 *   canSeeLine()      — may this role see the line at all (name, code,
 *                        price, discount, status)?
 *   canActOnResult()  — may this role act on the RESULT behind the line
 *                        (mark done, release, undo, open the bench page)?
 *   canViewResultPdf() — may this role open the result PDF? Everyone who can
 *                        act on it, plus reception once the line is released
 *                        (2026-09-24), so the counter can print it.
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
 * open the bench page)? Unchanged from the pre-split
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
 * May this role open a line's result PDF — to read it, or to print it for the
 * patient at the counter?
 *
 * Every role that may act on the result can (`canActOnResult`), at any status
 * the PDF exists — the lab reviews its own finished work before releasing it.
 *
 * Reception can too, but only once the line is RELEASED (owner decision,
 * 2026-09-24: the counter hands the printed result over, so it must be able
 * to print one). Released means the patient can already read it on the portal
 * — reception is handing over a copy of something that has left the building,
 * not seeing work still on the bench. A doctor line (consultation/procedure)
 * never has a result file, so it never qualifies.
 *
 * "Released" has to hold for the whole FILE, not just this line: a
 * consolidated chemistry report is one PDF linked to every test in the panel,
 * and release/undo are per line — so FBS can be released while Creatinine on
 * the same PDF is not (or was withdrawn). `reportReleased` is "every test
 * linked to the newest result is released" (allLinksReleased in
 * lib/results/release-eligibility.ts, the rule the portal already enforces);
 * reception needs it, the lab — reviewing its own work — does not.
 *
 * This is the gate the PDF route enforces; the pages call it too so they only
 * draw the Print button where the route will answer.
 */
export function canViewResultPdf(
  role: StaffSession["role"],
  line: {
    section: string | null | undefined;
    status: string;
    kind: string | null | undefined;
    reportReleased: boolean;
    /**
     * Sections of EVERY test on the line's result file (deleted ones
     * included). When given, a lab role must cover all of them — a shared
     * chemistry report prints every member's values, not only this line's
     * (report-section-gate.ts). Omit only where no file is known yet.
     */
    memberSections?: readonly (string | null)[];
  },
): boolean {
  if (canActOnResult(role, line.section)) {
    return (
      line.memberSections === undefined ||
      membersWithinSections(sectionsForRole(role), line.memberSections)
    );
  }
  return (
    role === "reception" &&
    line.status === "released" &&
    line.reportReleased &&
    line.kind != null &&
    !isDoctorKind(line.kind)
  );
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
