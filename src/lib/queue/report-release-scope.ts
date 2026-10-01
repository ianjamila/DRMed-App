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

/**
 * What a chemistry panel's Release sends when the panel's members belong to
 * more than one combined report. Each report is judged on its own: a finished
 * report releases even while a sibling report on the same panel still waits
 * (release_visit_results, 0198, refuses only the unfinished report). Members
 * with no report are plain rows and always go. Display-only preflight; pure.
 *
 * `readyIds` are the ready members to send (members' original order).
 * `reportBlock` is the first blocked report's wording, set only when nothing
 * is sendable and some report was the reason.
 */
export function panelReleaseScope(
  members: ReadonlyArray<{ id: string; status: string; resultId: string | null }>,
): { readyIds: string[]; reportBlock: string | null } {
  const byReport = new Map<string, Array<{ status: string; deleted: boolean }>>();
  for (const m of members) {
    if (m.resultId === null) continue;
    const list = byReport.get(m.resultId) ?? [];
    list.push({ status: m.status, deleted: false });
    byReport.set(m.resultId, list);
  }
  const blocked = new Set<string>();
  let firstBlock: string | null = null;
  for (const [resultId, reportMembers] of byReport) {
    const block = reportReleaseBlock(reportMembers);
    if (block === null) continue;
    blocked.add(resultId);
    firstBlock ??= block;
  }
  const readyIds = members
    .filter((m) => m.status === "ready_for_release" && (m.resultId === null || !blocked.has(m.resultId)))
    .map((m) => m.id);
  return { readyIds, reportBlock: readyIds.length === 0 ? firstBlock : null };
}
