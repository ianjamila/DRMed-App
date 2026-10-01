import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/types/database";
import type { StaffSession } from "@/lib/auth/require-staff";
import type { ReleaseMedium } from "@/lib/visits/release-media";
import type { SkippedRow } from "@/lib/queue/bulk-queue";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { RELEASE_REFUSAL_PATIENT_INACTIVE } from "@/lib/visits/release-messages";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { notifyResultReleased } from "@/lib/notifications/notify-released";
import { notifyResultsReleasedBulk } from "@/lib/notifications/notify-released-bulk";
import type { ReleaseNoticeOutcome } from "@/lib/notifications/release-notice-outcome";
import { scheduleReleaseStaffAlert } from "@/lib/notifications/release-staff-alert";
import { reportError } from "@/lib/observability/report-error";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { describeRacedRelease } from "./raced-release";

export type ReleasedRow = { id: string; name: string };

export type VisitReleaseOutcome = {
  /** Selected ids the write actually released (authoritative RETURNING). */
  changedIds: string[];
  /** Pulled-in report members (not selected) the write released. */
  alsoReleasedIds: string[];
  /** Selected ids NOT released, with the reason (refused by the database, raced, or a failed call). */
  skipped: SkippedRow[];
  warnings: string[];
  /** Every released row — a combined report is complete by construction, so all of it is announced. */
  announced: ReleasedRow[];
  /** What actually happened to the patient's notice; null when nothing was announced or sent. */
  notice: ReleaseNoticeOutcome | null;
};

export const RACED_REASON = "Released by someone else or changed just now.";
export const OUTSIDE_SECTIONS_REASON =
  "This test is outside the sections you can release — ask an admin.";
export const COULDNT_CONFIRM_RELEASE =
  "Couldn't confirm what was released — check the visit page.";

/** release_visit_results' report_* refusal codes → the shared REPORT_REFUSAL wording. */
const REPORT_CODE_REASON: Record<string, string> = {
  report_outside_sections: REPORT_REFUSAL.outside_sections,
  report_package_header: REPORT_REFUSAL.package_header,
  report_other_visit: REPORT_REFUSAL.other_visit,
  report_doctor_member: REPORT_REFUSAL.doctorMember,
  report_deleted_member: REPORT_REFUSAL.deletedMember,
};

interface RpcReleased {
  id: string;
  name: string;
  report_id: string | null;
  selected: boolean;
  released_at: string;
}
interface RpcRefused {
  id: string;
  code: string;
  report_id: string | null;
  count: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function parseReleaseResult(data: unknown): { released: RpcReleased[]; refused: RpcRefused[] } | null {
  if (!isObj(data) || !Array.isArray(data.released) || !Array.isArray(data.refused)) return null;
  const released = data.released;
  const refused = data.refused;
  const releasedOk = released.every(
    (r) => isObj(r) && typeof r.id === "string" && typeof r.name === "string" && isStrOrNull(r.report_id) && typeof r.selected === "boolean" && typeof r.released_at === "string",
  );
  const refusedOk = refused.every(
    (r) => isObj(r) && typeof r.id === "string" && typeof r.code === "string" && isStrOrNull(r.report_id) && typeof r.count === "number",
  );
  if (!releasedOk || !refusedOk) return null;
  return { released: released as RpcReleased[], refused: refused as RpcRefused[] };
}

function refusalReason(r: RpcRefused): string {
  if (r.code === "not_ready") return RACED_REASON;
  if (r.code === "outside_sections") return OUTSIDE_SECTIONS_REASON;
  if (r.code === "report_not_finished") return REPORT_REFUSAL.notFinished(r.count);
  return REPORT_CODE_REASON[r.code] ?? RACED_REASON;
}

/**
 * The p_audit argument of release_visit_results / undo_visit_release (0205):
 * the database writes the per-row audit rows itself, in the same transaction
 * as the change, from these caller extras plus the request ip / user agent.
 */
export async function releaseAuditArg(metadata: Record<string, Json>): Promise<Json> {
  const { ip, ua } = await ipAndAgent();
  return { metadata, ip, user_agent: ua };
}

/** The patient "result ready" notice for rows a caller decided to announce. Never throws. */
export async function notifyReleased(
  visitId: string,
  rows: readonly ReleasedRow[],
  medium: ReleaseMedium,
  // The release call's bulk_batch_id, stamped on the notice's own audit row
  // so the batch's Undo does not read it as a later, unrelated change.
  bulkBatchId?: string,
): Promise<ReleaseNoticeOutcome | null> {
  if (rows.length === 0) return null;
  try {
    if (rows.length === 1) {
      return await notifyResultReleased({ testRequestId: rows[0].id, visitId, releaseMedium: medium, bulkBatchId });
    } else {
      return await notifyResultsReleasedBulk({
        visitId,
        testRequestIds: rows.map((r) => r.id),
        testNames: rows.map((r) => r.name),
        releaseMedium: medium,
        bulkBatchId,
      });
    }
  } catch (err) {
    await reportError({
      scope: "notify/result-released-selection",
      error: err,
      metadata: { visit_id: visitId, test_request_ids: rows.map((r) => r.id) },
    });
    return { status: "failed", channels: [], reason: "sending failed" };
  }
}

/**
 * Release `selectedIds` (all on `visitId`, already eligibility-checked by the
 * caller) through release_visit_results (0198): the database plans the
 * whole-report rule under locks and writes in one statement, so a combined
 * report is released whole or not at all. The database also writes one
 * test_request.released audit row per released row in that transaction (0205
 * — keys visit_id, release_medium, bulk, selection, `auditMeta`, released_at),
 * so a lost response never leaves a release unaudited. Notifies the patient
 * (notifyReleased) and schedules the staff alert. Never returns a
 * failure: every problem lands the affected selected ids in `skipped`.
 */
export async function releaseVisitSelection(args: {
  supabase: SupabaseClient;
  session: Pick<StaffSession, "user_id" | "role">;
  visitId: string;
  selectedIds: readonly string[];
  medium: ReleaseMedium;
  auditMeta: Record<string, Json>;
  /**
   * A server-minted id for a call that offers Undo (visit page Release
   * selected): stamped as bulk_batch_id on EVERY released row's audit row —
   * report-mates pulled in included — and on the patient notice's audit row.
   */
  bulkBatchId?: string;
}): Promise<VisitReleaseOutcome> {
  const { supabase, session, visitId, medium, bulkBatchId } = args;
  const auditMeta: Record<string, Json> = bulkBatchId
    ? { ...args.auditMeta, bulk_batch_id: bulkBatchId }
    : args.auditMeta;
  const selected = Array.from(new Set(args.selectedIds));
  const skipped = new Map<string, string>();
  const skip = (ids: readonly string[], reason: string) => {
    for (const id of ids) if (!skipped.has(id)) skipped.set(id, reason);
  };
  const finish = (
    changedIds: string[],
    alsoReleasedIds: string[],
    announced: ReleasedRow[],
    notice: ReleaseNoticeOutcome | null = null,
  ): VisitReleaseOutcome => ({
    changedIds,
    alsoReleasedIds,
    skipped: selected.filter((id) => skipped.has(id)).map((id) => ({ id, reason: skipped.get(id)! })),
    warnings: [],
    announced,
    notice,
  });
  if (selected.length === 0) return finish([], [], []);
  const audit = await releaseAuditArg(auditMeta);

  const { data, error } = await withLifecycleRetry(() =>
    supabase.rpc("release_visit_results", {
      p_visit_id: visitId,
      p_test_request_ids: selected,
      p_medium: medium,
      p_actor: session.user_id,
      p_audit: audit,
    }),
  );
  if (error) {
    // P0058: the patient was deleted or merged (lifecycle lock assertion).
    skip(selected, error.code === "P0058" ? RELEASE_REFUSAL_PATIENT_INACTIVE : translatePgError(error));
    return finish([], [], []);
  }
  const result = parseReleaseResult(data);
  if (result === null) {
    // The call may have committed, so nothing is announced and the operator is sent to the page.
    await reportError({
      scope: "release/visit-results-malformed",
      error: new Error("release_visit_results returned an unexpected shape"),
      metadata: { visit_id: visitId, test_request_ids: selected },
    });
    skip(selected, COULDNT_CONFIRM_RELEASE);
    return finish([], [], []);
  }

  const { released, refused } = result;
  for (const r of refused) skip([r.id], refusalReason(r));
  const releasedRows: ReleasedRow[] = released.map((r) => ({ id: r.id, name: r.name }));
  const releasedSet = new Set(releasedRows.map((r) => r.id));
  // Every selected id is released or refused; anything else raced. A raced id
  // that is released NOW says by whom and when (one batched, never-throwing
  // read); every other raced id keeps the generic RACED_REASON.
  const raced = [
    ...refused.filter((r) => r.code === "not_ready").map((r) => r.id),
    ...selected.filter((id) => !releasedSet.has(id) && !skipped.has(id)),
  ];
  const named = await describeRacedRelease(supabase, raced, session.user_id);
  for (const r of refused) if (r.code === "not_ready") skipped.set(r.id, named.get(r.id) ?? RACED_REASON);
  for (const id of selected) if (!releasedSet.has(id)) skip([id], named.get(id) ?? RACED_REASON);

  const changedIds = released.filter((r) => r.selected).map((r) => r.id);
  const alsoReleasedIds = released.filter((r) => !r.selected).map((r) => r.id);
  let notice: ReleaseNoticeOutcome | null = null;
  if (releasedRows.length > 0) {
    notice = await notifyReleased(visitId, releasedRows, medium, bulkBatchId);
    scheduleReleaseStaffAlert(visitId, releasedRows.length);
  }
  return finish(changedIds, alsoReleasedIds, releasedRows, notice);
}
