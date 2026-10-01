"use server";

import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchOutdatedCopies } from "@/lib/results/copy-followups.server";
import { canRetryNotice } from "@/lib/results/copy-followups";
import { audit } from "@/lib/audit/log";
import { notifyResultCorrected } from "@/lib/notifications/notify-corrected";

export type MarkCopyContactedResult = { ok: true; data: null } | { ok: false; error: string };

// The audit row (result.patient_contacted) is written inside the RPC itself,
// in the same transaction as the update — see 0179's
// result_mark_copy_contacted.
export async function markCopyContactedAction(
  amendmentId: string,
): Promise<MarkCopyContactedResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false as const, error: "Only reception or admin can do this." };
  }
  const db = await createClient();
  const { error } = await db.rpc("result_mark_copy_contacted", {
    p_amendment_id: amendmentId,
  });
  if (error) return { ok: false as const, error: translatePgError(error) };
  revalidatePath("/staff/result-follow-ups");
  return { ok: true as const, data: null };
}

export type RetryNoticeResult = { ok: true; data: { outcome: string } } | { ok: false; error: string };

// 0188: "Retry notice" for a patient notice that failed with a send error.
// The row must be on the caller's own Result Follow-ups list — read through
// the signed-in RPC, which is reception/admin only and active patients only —
// and that row supplies the result, patient and test names server-side, so
// nothing about the patient or the message comes from the browser.
// notifyResultCorrected then re-checks the active patient and the release
// status, claims through result_retry_patient_notify (atomic: a second click
// gets "already"), sends, records the outcome and audits it (retry: true).
export async function retryPatientNoticeAction(amendmentId: string): Promise<RetryNoticeResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false as const, error: "Only reception or admin can do this." };
  }
  const db = await createClient();
  const list = await fetchOutdatedCopies(db, false);
  if (!list.ok) return { ok: false as const, error: translatePgError(list.error) };
  const row = list.rows.find((r) => r.latest_amendment_id === amendmentId);
  if (!row || !canRetryNotice(row)) {
    return { ok: false as const, error: "There's nothing to retry for this patient any more — refresh the list." };
  }

  // The same label the edit's own notice used: a combined report is named
  // by its report group (amend-consolidated.ts), a single test by itself.
  const admin = createAdminClient();
  const { data: res } = await admin
    .from("results")
    .select("report_group_id")
    .eq("id", row.result_id)
    .maybeSingle();
  const { data: group } = res?.report_group_id
    ? await admin.from("report_groups").select("name").eq("id", res.report_group_id).maybeSingle()
    : { data: null };
  const testName = group?.name ?? (row.test_names || "your result");

  const outcome = await notifyResultCorrected({
    amendmentId,
    resultId: row.result_id,
    testName,
    actorId: session.user_id,
    patientId: row.patient_id,
    retry: true,
  });
  revalidatePath("/staff/result-follow-ups");
  return { ok: true as const, data: { outcome } };
}

export type RetryReleaseNoticeResult = { ok: true; data: { queued: true } } | { ok: false; error: string };

// 0210/0212: the manual Retry for a "result ready" notice the sender gave up on
// (status `abandoned`). Admin only, judged on the EFFECTIVE role (an admin
// viewing as reception cannot). retry_release_notice is service_role-only, so it
// goes through the admin client after the role check; it puts the notice back in
// the queue as due now with a fresh set of attempts (a channel already sent stays
// sent and a text with an unknown outcome is still never resent) and the 5-minute
// sweeper sends it. Nothing about the patient or the message comes from the browser.
export async function retryReleaseNoticeAction(noticeId: string): Promise<RetryReleaseNoticeResult> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: false as const, error: "Only an admin can retry a result notice." };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noticeId)) {
    return { ok: false as const, error: "That notice isn't valid — refresh the list." };
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("retry_release_notice", { p_id: noticeId });
  if (error) return { ok: false as const, error: "Couldn't queue the retry — try again in a moment." };
  if (data !== true) {
    return { ok: false as const, error: "That notice isn't waiting for a retry any more — refresh the list." };
  }
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.notice_retry_requested",
    resource_type: "release_notice",
    resource_id: noticeId,
    metadata: { notice_id: noticeId },
  });
  revalidatePath("/staff/result-follow-ups");
  return { ok: true as const, data: { queued: true as const } };
}
