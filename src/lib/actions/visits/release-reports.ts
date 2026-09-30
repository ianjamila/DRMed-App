import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/types/database";
import type { StaffSession } from "@/lib/auth/require-staff";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { MAX_BULK_RECORDS } from "@/lib/ui/bulk-selection";
import { isDoctorKind } from "@/lib/visits/order-lines";
import type { ReleaseMedium } from "@/lib/visits/release-media";
import type { SkippedRow } from "@/lib/queue/bulk-queue";
import { planReportRelease, type ReportMember } from "@/lib/queue/report-release-scope";
import { releaseRows, notifyReleased, type ReleasedRow } from "@/lib/actions/visits/release-rows";
import { scheduleReleaseStaffAlert } from "@/lib/notifications/release-staff-alert";

export type VisitReleaseOutcome = {
  /** Selected ids the write actually released (authoritative RETURNING). */
  changedIds: string[];
  /** Pulled-in report members (not selected) the write released. */
  alsoReleasedIds: string[];
  /** Selected ids NOT released, with the reason (plan refusal, fail-closed read, DB error, raced). */
  skipped: SkippedRow[];
  warnings: string[];
  /** Released rows that are plain or on a report verified complete — the only rows announced. */
  announced: ReleasedRow[];
};

export const COULDNT_CHECK_REPORT =
  "Couldn't check which report these tests belong to — try again.";
export const TOO_MANY_AFTER_EXPANSION =
  "Too many tests once whole reports are included — select fewer.";
export const RACED_REASON = "Released by someone else or changed just now.";
export const REPORT_CHANGED_REASON =
  "This combined report changed while releasing — some tests were released, the rest were not; the patient was not notified. Finish it from the report's page.";
export const UNVERIFIED_WARNING =
  "Released, but couldn't confirm the whole report went out — the patient was not notified. Check the report page.";

const MEMBERSHIP_SELECT =
  "test_request_id, result_id, test_requests!inner ( id, visit_id, status, deleted_at, is_package_header, services!inner ( section, kind ) )";

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * Every member of the given reports — deleted ones included, exactly like the
 * undo read. `null` on a read error: callers must fail closed, never read a
 * failed or empty result as "no combined report".
 */
async function readMembership(
  supabase: SupabaseClient,
  resultIds: readonly string[],
): Promise<ReportMember[] | null> {
  const { data, error } = await supabase
    .from("result_test_requests")
    .select(MEMBERSHIP_SELECT)
    .in("result_id", [...resultIds]);
  if (error) return null;
  return (data ?? []).map((l) => {
    const tr = one(l.test_requests as unknown as MemberTr | MemberTr[] | null);
    const svc = one(tr?.services);
    return {
      testRequestId: l.test_request_id as string,
      resultId: l.result_id as string,
      visitId: tr?.visit_id ?? "",
      isPackageHeader: tr?.is_package_header ?? false,
      section: svc?.section ?? null,
      status: tr?.status ?? "",
      deleted: (tr?.deleted_at ?? null) !== null,
      isDoctorLine: svc ? isDoctorKind(svc.kind) : false,
    };
  });
}

interface MemberTr {
  visit_id: string;
  status: string;
  deleted_at: string | null;
  is_package_header: boolean;
  services: { section: string | null; kind: string } | { section: string | null; kind: string }[] | null;
}

/**
 * Release `selectedIds` (all on `visitId`, already eligibility-checked by the
 * caller) with the whole-report rule. Never releases part of a combined
 * report on purpose; detects and withholds when a race makes it partial.
 * Notifies the patient (notifyReleased) and schedules the staff alert for
 * `announced` only. Never returns a failure: every problem lands the affected
 * selected ids in `skipped`.
 */
export async function releaseVisitSelection(args: {
  supabase: SupabaseClient;
  session: Pick<StaffSession, "user_id" | "role">;
  visitId: string;
  selectedIds: readonly string[];
  medium: ReleaseMedium;
  auditMeta: Record<string, Json>;
}): Promise<VisitReleaseOutcome> {
  const { supabase, session, visitId, medium, auditMeta } = args;
  const selected = Array.from(new Set(args.selectedIds));
  const skipped = new Map<string, string>();
  const warnings: string[] = [];
  const skip = (ids: readonly string[], reason: string) => {
    for (const id of ids) if (!skipped.has(id)) skipped.set(id, reason);
  };
  const finish = (
    changedIds: string[],
    alsoReleasedIds: string[],
    announced: ReleasedRow[],
  ): VisitReleaseOutcome => ({
    changedIds,
    alsoReleasedIds,
    skipped: selected.filter((id) => skipped.has(id)).map((id) => ({ id, reason: skipped.get(id)! })),
    warnings,
    announced,
  });
  if (selected.length === 0) return finish([], [], []);

  // 1. Which reports do the selected tests belong to?
  const { data: links, error: linkErr } = await supabase
    .from("result_test_requests")
    .select("test_request_id, result_id")
    .in("test_request_id", selected);
  if (linkErr) {
    skip(selected, COULDNT_CHECK_REPORT);
    return finish([], [], []);
  }
  const linkedByResult = new Map<string, string[]>();
  for (const l of links ?? []) {
    linkedByResult.set(l.result_id, [...(linkedByResult.get(l.result_id) ?? []), l.test_request_id]);
  }
  const touched = Array.from(linkedByResult.keys());

  // 2. Every member of those reports (fail closed on error or truncation).
  let members: ReportMember[] = [];
  if (touched.length > 0) {
    const read = await readMembership(supabase, touched);
    if (read === null) {
      skip(selected, COULDNT_CHECK_REPORT);
      return finish([], [], []);
    }
    members = read;
  }
  const memberIdsByResult = new Map<string, Set<string>>();
  for (const mem of members) {
    const set = memberIdsByResult.get(mem.resultId) ?? new Set<string>();
    set.add(mem.testRequestId);
    memberIdsByResult.set(mem.resultId, set);
  }
  const truncated = new Set<string>();
  for (const [rid, linkedIds] of linkedByResult) {
    const got = memberIdsByResult.get(rid);
    if (!got || linkedIds.some((id) => !got.has(id))) truncated.add(rid);
  }
  for (const rid of truncated) skip(linkedByResult.get(rid)!, COULDNT_CHECK_REPORT);
  const usable = members.filter((mem) => !truncated.has(mem.resultId));

  // 3. Plan.
  const plan = planReportRelease({
    selectedIds: selected.filter((id) => !skipped.has(id)),
    members: usable,
    visitId,
    allowedSections: sectionsForRole(session.role),
  });
  for (const rej of plan.rejected) skip(rej.selectedIds, rej.reason);
  if (plan.releaseIds.length > MAX_BULK_RECORDS) {
    skip(selected, TOO_MANY_AFTER_EXPANSION);
    return finish([], [], []);
  }
  if (plan.releaseIds.length === 0) return finish([], [], []);

  // 4. The one write.
  const res = await releaseRows({
    supabase,
    session,
    visitId,
    ids: plan.releaseIds,
    medium,
    auditMeta,
  });
  if (!res.ok) {
    skip(selected, res.error);
    return finish([], [], []);
  }
  const released = res.released;
  const releasedSet = new Set(released.map((r) => r.id));
  const changedIds = selected.filter((id) => releasedSet.has(id));
  const alsoReleasedIds = plan.alsoIds.filter((id) => releasedSet.has(id));

  // 5. Completeness of every combined report this write touched.
  const reportIds = Array.from(new Set(Object.values(plan.reportOf)));
  const expected = new Map<string, string[]>();
  for (const mem of usable) {
    if (!reportIds.includes(mem.resultId)) continue;
    expected.set(mem.resultId, [...(expected.get(mem.resultId) ?? []), mem.testRequestId]);
  }
  const withheld = new Set<string>(); // ids on a report that must not be announced
  if (reportIds.length > 0 && released.some((r) => plan.reportOf[r.id] !== undefined)) {
    const after = await readMembership(supabase, reportIds);
    const statusOf = new Map((after ?? []).map((r) => [r.testRequestId, r.status]));
    for (const rid of reportIds) {
      const ids = expected.get(rid) ?? [];
      const mine = ids.filter((id) => releasedSet.has(id));
      if (mine.length === 0) continue; // this write released nothing of it
      for (const id of ids) withheld.add(id);
      if (after === null || ids.length === 0 || ids.some((id) => !statusOf.has(id))) {
        if (!warnings.includes(UNVERIFIED_WARNING)) warnings.push(UNVERIFIED_WARNING);
        continue;
      }
      if (ids.every((id) => statusOf.get(id) === "released")) {
        for (const id of ids) withheld.delete(id);
        continue;
      }
      // Raced between plan and write: part of the report went out, part did not.
      const firstSelected = selected.find((id) => ids.includes(id));
      if (firstSelected !== undefined && !changedIds.includes(firstSelected)) {
        skipped.set(firstSelected, REPORT_CHANGED_REASON);
      } else if (!warnings.includes(REPORT_CHANGED_REASON)) {
        warnings.push(REPORT_CHANGED_REASON);
      }
    }
  }

  // 6. Every selected id is now changed or skipped.
  for (const id of selected) {
    if (!releasedSet.has(id)) skip([id], RACED_REASON);
  }

  // 7. Announce only plain rows and reports verified complete.
  const announced = released.filter((r) => !withheld.has(r.id));
  if (announced.length > 0) {
    await notifyReleased(visitId, announced, medium);
    scheduleReleaseStaffAlert(visitId, announced.length);
  }
  return finish(changedIds, alsoReleasedIds, announced);
}
