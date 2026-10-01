import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditChecked, type AuditEntry } from "@/lib/audit/log";
import type { Json } from "@/types/database";
import { patientAlreadyAskedForReview } from "./review-cta";
import { inactiveSkipAuditEntry } from "./inactive-recipient-audit";
import { classifySkip, inactiveCodeOf } from "./release-notice-reasons";
import type { ReleaseNoticeRow } from "./release-notice-types";

type Admin = ReturnType<typeof createAdminClient>;

// The terminal audit row of a release notice (0210/0212). A notice is audited
// ONCE, when it reaches a terminal status: the sender writes the row right after
// finish_release_notice answers, then stamps release_notices.audited_at through
// mark_release_notice_audited. A crash between the two — or a claim that closed
// an exhausted lease as `abandoned` — leaves a terminal row with audited_at
// null, which the sweeper finds and audits here WITHOUT the live send context
// (rebuilding from the row alone).
//
// Every row for a test_request carries the release's bulk_batch_id when the
// notice has one: batch Undo's changedSince guard (loadOwnBatchRows) reads any
// LATER audit row on the same resource that lacks it as an independent change
// and would refuse to undo the release.

/** One channel as the audit row reports it. */
export interface ChannelView {
  state: "sent" | "skipped" | "failed" | "unknown" | "todo";
  id?: string | number | null;
  reason?: string | null;
  error?: string | null;
  /** The address the email went to (audit_log keeps it, release_notices never does). */
  to?: string | null;
}

/** What the live send knows and a rebuilt-from-the-row audit does not. */
export interface LiveAuditContext {
  patientId: string;
  testNames: string[];
  testIds: string[];
  includeReviewCta: boolean;
  sms: ChannelView;
  email: ChannelView;
}

/** The lab-only ids and names a re-audit rebuilds (what the live send announced). */
export interface RebuiltTests {
  testIds: string[];
  testNames: string[];
}

export type AuditNoticeResult = "stamped" | "already_audited" | "audit_failed" | "stamp_failed";

function channelAudit(kind: "sms" | "email", v: ChannelView): Json {
  if (v.state === "sent") {
    return kind === "email" && v.to ? { ok: true, id: String(v.id ?? ""), to: v.to } : { ok: true, id: v.id ?? "" };
  }
  if (v.state === "skipped") return { ok: false, skipped: true, reason: v.reason ?? "not sent" };
  const base = { ok: false, error: v.error ?? v.reason ?? "sending failed" };
  return kind === "email" && v.to ? { ...base, to: v.to } : base;
}

function viewFromRow(row: ReleaseNoticeRow, kind: "sms" | "email"): ChannelView {
  const state = (kind === "sms" ? row.sms_state : row.email_state) as ChannelView["state"];
  return {
    state,
    id: kind === "sms" ? row.sms_provider_id : row.email_provider_id,
    reason: row.skip_reason,
    error: row.last_error,
  };
}

/** The result.notified metadata, in exactly today's shape plus notice_id. */
export function notifiedMetadata(args: {
  row: ReleaseNoticeRow;
  testNames: string[] | null;
  testIds: string[];
  sms: ChannelView;
  email: ChannelView;
  reviewCtaShown: boolean;
  /** sample / physical skips carry release_medium, like the legacy audit. */
  withMedium: boolean;
}): Record<string, Json> {
  const { row, testNames, testIds, sms, email, reviewCtaShown, withMedium } = args;
  const single = testIds.length === 1;
  const names = testNames && testNames.length === testIds.length ? testNames : null;
  return {
    visit_id: row.visit_id,
    ...(single && names ? { test_name: names[0] } : {}),
    ...(withMedium ? { release_medium: row.release_medium } : {}),
    sms: channelAudit("sms", sms),
    email: channelAudit("email", email),
    review_cta: { shown: reviewCtaShown },
    ...(single ? {} : {
      bulk: true,
      count: testIds.length,
      ...(names ? { test_names: names } : {}),
      test_request_ids: testIds,
    }),
    notice_id: row.id,
    ...(row.bulk_batch_id ? { bulk_batch_id: row.bulk_batch_id } : {}),
  };
}

const skippedChannel = (reason: string): ChannelView => ({ state: "skipped", reason });

/** The audit entry a terminal notice earns, or null (a doctor-only skip has none today). */
async function buildEntry(
  admin: Admin,
  row: ReleaseNoticeRow,
  live: LiveAuditContext | undefined,
  rebuilt: RebuiltTests | undefined,
): Promise<AuditEntry | null> {
  const ids = live?.testIds.length ? live.testIds : rebuilt?.testIds.length ? rebuilt.testIds : row.test_request_ids;
  const names = live?.testNames ?? rebuilt?.testNames ?? null;
  const patientId = live?.patientId ?? (await patientIdOfVisit(admin, row.visit_id));
  const firstId = ids[0];
  const batch = row.bulk_batch_id ? { bulk_batch_id: row.bulk_batch_id } : {};
  const base = {
    actor_id: null,
    actor_type: "system" as const,
    patient_id: patientId,
    resource_type: "test_request",
    resource_id: firstId,
  };

  if (row.status === "abandoned" || row.status === "cancelled" || row.status === "suppressed") {
    return {
      ...base,
      action: `result.notice_${row.status}`,
      metadata: {
        notice_id: row.id,
        visit_id: row.visit_id,
        test_request_ids: row.test_request_ids,
        attempts: row.attempts,
        email_state: row.email_state,
        sms_state: row.sms_state,
        ...(row.status === "abandoned" && row.last_error ? { last_error: row.last_error } : {}),
        ...(row.skip_reason ? { reason: row.skip_reason } : {}),
        ...batch,
      },
    };
  }

  if (row.status === "skipped") {
    const kind = classifySkip(row.skip_reason);
    if (kind === "doctor") return null;
    if (kind === "inactive" || kind === "walk_in") {
      if (!patientId) return null;
      const single = ids.length === 1;
      const entry = inactiveSkipAuditEntry({
        sender: single ? "notify-released" : "notify-released-bulk",
        patientId,
        reason: kind === "walk_in" ? "walk_in" : inactiveCodeOf(row.skip_reason),
        resourceType: single ? "test_request" : "visit",
        resourceId: single ? firstId : row.visit_id,
        bulkBatchId: row.bulk_batch_id,
      });
      return { ...entry, metadata: { ...(entry.metadata as Record<string, Json>), notice_id: row.id } };
    }
    // sample / physical: both channels skipped, like the legacy audit. Anything
    // else (a channel not set up, no address) reports each channel as it ended.
    const forced = kind === "sample" || kind === "physical";
    const reason = row.skip_reason ?? "not sent";
    return {
      ...base,
      action: "result.notified",
      metadata: notifiedMetadata({
        row,
        testNames: names,
        testIds: ids,
        sms: forced ? skippedChannel(reason) : (live?.sms ?? viewFromRow(row, "sms")),
        email: forced ? skippedChannel(reason) : (live?.email ?? viewFromRow(row, "email")),
        reviewCtaShown: false,
        withMedium: forced,
      }),
    };
  }

  if (row.status === "sent") {
    const sms = live?.sms ?? viewFromRow(row, "sms");
    const email = live?.email ?? viewFromRow(row, "email");
    // The CTA is shown only when an email actually went out. A rebuilt audit
    // cannot know whether this send carried it, so it asks the same question the
    // send asked: had the patient already been shown it?
    const emailWentOut = email.state === "sent";
    const reviewCtaShown = live
      ? live.includeReviewCta && emailWentOut
      : emailWentOut && patientId !== null && !(await patientAlreadyAskedForReview(admin, patientId));
    return {
      ...base,
      action: "result.notified",
      metadata: notifiedMetadata({
        row,
        testNames: names,
        testIds: ids,
        sms,
        email,
        reviewCtaShown,
        withMedium: false,
      }),
    };
  }
  return null;
}

async function patientIdOfVisit(admin: Admin, visitId: string): Promise<string | null> {
  // Deliberately spans a soft-deleted visit: this is the audit trail of a notice
  // that may have been cancelled BECAUSE its visit was deleted.
  const { data } = await admin.from("visits").select("patient_id").eq("id", visitId).maybeSingle();
  return data?.patient_id ?? null;
}

/** Every audit action a terminal notice can earn (release-notice-audit's buildEntry). */
const NOTICE_AUDIT_ACTIONS = [
  "result.notified",
  "result.notice_abandoned",
  "result.notice_cancelled",
  "result.notice_suppressed",
  "notification.skipped_inactive_patient",
];
const AUDIT_LOOKBACK_MS = 5 * 60 * 1000;

/**
 * Was this notice already audited? Keyed on metadata.notice_id and BOUNDED by the
 * existing created_at index: the audit is always written AFTER finish set
 * resolved_at, so only rows from (resolved_at - 5 min) on can be this notice's.
 * No new audit_log index (it would lock writes on a hot table).
 * null = the read failed (cannot tell): the caller must not write a possible duplicate nor stamp.
 */
async function alreadyAudited(admin: Admin, row: ReleaseNoticeRow): Promise<boolean | null> {
  const since = new Date(Date.parse(row.resolved_at ?? row.created_at) - AUDIT_LOOKBACK_MS).toISOString();
  const { data, error } = await admin
    .from("audit_log")
    .select("id")
    .in("action", NOTICE_AUDIT_ACTIONS)
    .gte("created_at", since)
    .eq("metadata->>notice_id", row.id)
    .limit(1);
  if (error) return null;
  return Boolean(data && data.length > 0);
}

/**
 * Writes a terminal notice's audit row, then stamps it audited. Never throws.
 * `live` is the sender's own context; without it (the sweeper's re-audit) the
 * row is rebuilt from what the database holds, and an audit row for this notice
 * that already exists is not written a second time.
 */
export async function auditTerminalNotice(
  admin: Admin,
  row: ReleaseNoticeRow,
  live?: LiveAuditContext,
  rebuilt?: RebuiltTests,
): Promise<AuditNoticeResult> {
  try {
    if (row.resolved_at === null) return "already_audited"; // not terminal: nothing to audit
    const wrote = await (async () => {
      if (!live) {
        const seen = await alreadyAudited(admin, row);
        if (seen === null) return false;
        if (seen) return true;
      }
      const entry = await buildEntry(admin, row, live, rebuilt);
      if (entry === null) return true;
      return auditChecked(entry);
    })();
    if (!wrote) return "audit_failed";
    const { data, error } = await admin.rpc("mark_release_notice_audited", { p_id: row.id });
    if (error) return "stamp_failed";
    return data === true ? "stamped" : "already_audited";
  } catch {
    return "audit_failed";
  }
}
