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
