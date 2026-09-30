// Whole-report release for the lab queue. The portal serves a combined
// report's PDF only when every linked test — deleted ones included — is
// released (allLinksReleased), so the queue releases a combined report whole
// or not at all. Structural checks reuse the undo expansion (0172); the
// status/deletion rules are release-specific. Pure.
import {
  expandUndoReleaseScope,
  type UndoScopeMemberRow,
  type UndoScopeRejectionReason,
} from "@/lib/visits/undo-release-scope";

export interface ReportMember extends UndoScopeMemberRow {
  status: string;
  deleted: boolean;
  isDoctorLine: boolean;
}

export const REPORT_REFUSAL = {
  outside_sections: "This combined report has tests outside the sections you can release — ask an admin.",
  package_header: "This combined report includes a package header, which shouldn't happen — ask an admin to check it.",
  other_visit: "This combined report spans more than one visit, which shouldn't happen — ask an admin to check it.",
  deletedMember: "A deleted test is still on this combined report, so the patient could never open it — ask an admin.",
  doctorMember: "A consultation is linked to this combined report, which shouldn't happen — ask an admin to check it.",
  notFinished: (n: number) =>
    `Part of this combined report isn't finished — ${n} test${n === 1 ? " is" : "s are"} still awaiting a result or sign-off.`,
} satisfies Record<UndoScopeRejectionReason, unknown> & Record<string, unknown>;

/** The status/deletion half of the whole-report rule, shared by the planner and the visit page's preflight. */
export function reportReleaseBlock(
  members: ReadonlyArray<{ status: string; deleted: boolean }>,
): string | null {
  if (members.some((x) => x.deleted && x.status !== "released")) return REPORT_REFUSAL.deletedMember;
  const unfinished = members.filter(
    (x) => !x.deleted && x.status !== "ready_for_release" && x.status !== "released",
  );
  return unfinished.length > 0 ? REPORT_REFUSAL.notFinished(unfinished.length) : null;
}

export interface ReportReleasePlan {
  /** Ids to send to the release write: survivors + pulled-in report members. */
  releaseIds: string[];
  /** Pulled-in members the operator did not select. */
  alsoIds: string[];
  rejected: { resultId: string; selectedIds: string[]; reason: string }[];
  /** testRequestId → resultId for every member of a touched combined report. */
  reportOf: Record<string, string>;
}

export function planReportRelease(input: {
  selectedIds: readonly string[];
  members: readonly ReportMember[];
  visitId: string;
  allowedSections: readonly string[] | null;
}): ReportReleasePlan {
  const byResult = new Map<string, ReportMember[]>();
  for (const mem of input.members) {
    byResult.set(mem.resultId, [...(byResult.get(mem.resultId) ?? []), mem]);
  }
  const reportOf: Record<string, string> = {};
  for (const [rid, mems] of byResult) {
    if (mems.length > 1) for (const mem of mems) reportOf[mem.testRequestId] = rid;
  }

  const selected = new Set(input.selectedIds);
  const rejected: ReportReleasePlan["rejected"] = [];
  const refused = new Set<string>();
  const pulled = new Set<string>();

  for (const [rid, mems] of byResult) {
    if (mems.length <= 1) continue;
    const mine = mems.filter((x) => selected.has(x.testRequestId)).map((x) => x.testRequestId);
    if (mine.length === 0) continue;
    let reason: string | null = null;
    const structural = expandUndoReleaseScope({
      selectedIds: mine,
      members: mems,
      visitId: input.visitId,
      allowedSections: input.allowedSections,
    });
    if (!structural.ok) reason = REPORT_REFUSAL[structural.reason];
    else if (mems.some((x) => x.isDoctorLine)) reason = REPORT_REFUSAL.doctorMember;
    else reason = reportReleaseBlock(mems);
    if (reason) {
      rejected.push({ resultId: rid, selectedIds: mine, reason });
      for (const x of mems) refused.add(x.testRequestId);
      continue;
    }
    for (const x of mems) {
      if (!x.deleted && x.status === "ready_for_release") pulled.add(x.testRequestId);
    }
  }

  const releaseIds = Array.from(
    new Set([...input.selectedIds.filter((id) => !refused.has(id)), ...pulled]),
  );
  return { releaseIds, alsoIds: releaseIds.filter((id) => !selected.has(id)), rejected, reportOf };
}
