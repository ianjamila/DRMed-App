// Whole-report release for the lab queue. The portal serves a combined
// report's PDF only when every linked test — deleted ones included — is
// released (allLinksReleased), so the queue releases a combined report whole
// or not at all. release_visit_results (0198) enforces the rule in the database;
// this file keeps the wording of its refusals and the pages' display-only
// preflight. Pure.
import type { UndoScopeRejectionReason } from "@/lib/visits/undo-release-scope";

/** Start of every notFinished refusal — lets a caller tell "waiting on a result or sign-off" apart from a hard refusal. */
export const NOT_FINISHED_PREFIX = "Part of this combined report isn't finished";

export const REPORT_REFUSAL = {
  outside_sections: "This combined report has tests outside the sections you can release — ask an admin.",
  package_header: "This combined report includes a package header, which shouldn't happen — ask an admin to check it.",
  other_visit: "This combined report spans more than one visit, which shouldn't happen — ask an admin to check it.",
  deletedMember: "A deleted test is still on this combined report, so the patient could never open it — ask an admin.",
  doctorMember: "A consultation is linked to this combined report, which shouldn't happen — ask an admin to check it.",
  notFinished: (n: number) =>
    `${NOT_FINISHED_PREFIX} — ${n} test${n === 1 ? " is" : "s are"} still awaiting a result or sign-off.`,
} satisfies Record<UndoScopeRejectionReason, unknown> & Record<string, unknown>;

/** The status/deletion half of the whole-report rule, for the pages' display-only preflight. */
export function reportReleaseBlock(
  members: ReadonlyArray<{ status: string; deleted: boolean }>,
): string | null {
  if (members.some((x) => x.deleted && x.status !== "released")) return REPORT_REFUSAL.deletedMember;
  const unfinished = members.filter(
    (x) => !x.deleted && x.status !== "ready_for_release" && x.status !== "released",
  );
  return unfinished.length > 0 ? REPORT_REFUSAL.notFinished(unfinished.length) : null;
}

/** Shown when a panel's (or report's) members couldn't be read — every Release on it is refused (fail closed). */
export const PANEL_UNREADABLE = "Couldn't load this panel's tests — refresh the page.";

/** One linked test of a combined report, as release_visit_results sees it (any visit, any group, deleted too). */
export interface FullMember {
  id: string;
  status: string;
  deleted: boolean;
  visitId: string;
  /** services.section; null for a missing service or a null section — outside every role's list. */
  section: string | null;
  isPackageHeader: boolean;
  /** services.kind is doctor_consultation / doctor_procedure. */
  isDoctor: boolean;
}

/**
 * The whole-report rule over a combined report's FULL membership, in the order
 * release_visit_results (0205 §5a) refuses: outside sections, package header,
 * other visit, doctor member, then the status/deletion half
 * (reportReleaseBlock). `sections` is sectionsForRole(role), null =
 * unrestricted. A report with ONE link is a plain row, not a combined report
 * (the RPC's `having count(*) > 1`), so it is never refused here. Pure.
 */
export function fullReportReleaseBlock(
  members: ReadonlyArray<FullMember>,
  ctx: { visitId: string; sections: readonly string[] | null },
): string | null {
  if (members.length <= 1) return null;
  const { sections } = ctx;
  if (sections !== null && members.some((m) => m.section === null || !sections.includes(m.section))) {
    return REPORT_REFUSAL.outside_sections;
  }
  if (members.some((m) => m.isPackageHeader)) return REPORT_REFUSAL.package_header;
  if (members.some((m) => m.visitId !== ctx.visitId)) return REPORT_REFUSAL.other_visit;
  if (members.some((m) => m.isDoctor)) return REPORT_REFUSAL.doctorMember;
  return reportReleaseBlock(members);
}

/**
 * What a chemistry panel's Release sends when the panel's members belong to
 * more than one combined report. Each report is judged on its own: a finished
 * report releases even while a sibling report on the same panel still waits
 * (release_visit_results, 0198, refuses only the unfinished report). Members
 * with no report are plain rows and always go. Display-only preflight; pure.
 *
 * A report is judged on its FULL membership (`reports`, from
 * fetchReportMembers), not just the panel's own members: the database counts
 * a member in another report group, on another visit, or deleted. A report
 * with a single link is a plain row. A report missing from `reports` could
 * not be read, so it is blocked with PANEL_UNREADABLE (fail closed).
 *
 * `readyIds` are the ready members to send (members' original order).
 * `reportBlock` is the first blocked report's wording, set only when nothing
 * is sendable and some report was the reason.
 */
export function panelReleaseScope(
  members: ReadonlyArray<{ id: string; status: string; resultId: string | null }>,
  reports: ReadonlyMap<string, ReadonlyArray<FullMember>>,
  ctx: { visitId: string; sections: readonly string[] | null },
): { readyIds: string[]; reportBlock: string | null } {
  const blocked = new Set<string>();
  let firstBlock: string | null = null;
  const judged = new Set<string>();
  for (const m of members) {
    if (m.resultId === null || judged.has(m.resultId)) continue;
    judged.add(m.resultId);
    const full = reports.get(m.resultId);
    const block = full ? fullReportReleaseBlock(full, ctx) : PANEL_UNREADABLE;
    if (block === null) continue;
    blocked.add(m.resultId);
    firstBlock ??= block;
  }
  const readyIds = members
    .filter((m) => m.status === "ready_for_release" && (m.resultId === null || !blocked.has(m.resultId)))
    .map((m) => m.id);
  return { readyIds, reportBlock: readyIds.length === 0 ? firstBlock : null };
}
