import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OutboxCounts } from "./release-notice-health";
import { formatPatientName } from "@/lib/patients/format-name";

// Result Follow-ups' "result-ready messages that did not go out" (0210/0212):
// release notices the sender gave up on (`abandoned`), plus how many are still
// waiting for an automatic retry. release_notices is service_role-only, so this
// reads through the admin client AFTER the page has gated the role. It selects
// ids, states, the patient's NAME and DRM-ID and the already-redacted
// last_error — never a phone number or an email address (RA 10173).

export interface StuckNoticeRow {
  id: string;
  visit_id: string;
  visit_number: string;
  patient_name: string;
  drm_id: string;
  test_count: number;
  attempts: number;
  gave_up_at: string | null;
  last_error: string | null;
}

export type StuckNotices =
  | { ok: true; abandoned: StuckNoticeRow[]; waitingForRetry: number; capped: boolean }
  | { ok: false };

export const STUCK_NOTICE_LIMIT = 200;

// The ONE definition of "an abandoned notice someone can still act on": the
// patient's visit and the patient are live. The follow-ups list, the Cron
// Health abandoned counts and the dashboard card all go through it, so they
// can never disagree. Needs the `visits!inner ( patients!inner ( ... ) )` embed.
export const LIVE_ABANDONED_FILTERS = [
  ["visits.deleted_at", null],
  ["visits.patients.deleted_at", null],
  ["visits.patients.merged_into_id", null],
] as const;

interface LiveFilterable<T> {
  eq(column: string, value: string): T;
  is(column: string, value: null): T;
}
export function onlyLiveAbandoned<T extends LiveFilterable<T>>(q: T): T {
  let out = q.eq("status", "abandoned");
  for (const [col, val] of LIVE_ABANDONED_FILTERS) out = out.is(col, val);
  return out;
}

const COUNT_EMBED = "id, visits!inner ( patients!inner ( id ) )";

type PatientEmbed = { first_name: string; middle_name: string | null; last_name: string; drm_id: string };
type VisitEmbed = { visit_number: string; patients: PatientEmbed | PatientEmbed[] | null };

export async function fetchStuckNotices(): Promise<StuckNotices> {
  const admin = createAdminClient();

  // A deleted visit, or a deleted / merged patient, is never listed: nobody is
  // to be contacted about it (the sender cancels or skips those anyway).
  const abandoned = await onlyLiveAbandoned(
    admin
      .from("release_notices")
      .select(
        `id, visit_id, test_request_ids, attempts, resolved_at, last_error,
       visits!inner ( visit_number, patients!inner ( first_name, middle_name, last_name, drm_id ) )`,
      ),
  )
    .order("resolved_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(STUCK_NOTICE_LIMIT + 1);
  if (abandoned.error) return { ok: false };

  const waiting = await admin
    .from("release_notices")
    .select("id", { count: "exact", head: true })
    .eq("status", "retry");
  if (waiting.error) return { ok: false };

  const rows = abandoned.data ?? [];
  const mapped: StuckNoticeRow[] = rows.slice(0, STUCK_NOTICE_LIMIT).map((r) => {
    const visit = (Array.isArray(r.visits) ? r.visits[0] : r.visits) as VisitEmbed | null;
    const patient = Array.isArray(visit?.patients) ? visit?.patients[0] : visit?.patients;
    return {
      id: r.id,
      visit_id: r.visit_id,
      visit_number: visit?.visit_number ?? "",
      patient_name: (patient ? formatPatientName(patient) : "") || "(no name on file)",
      drm_id: patient?.drm_id ?? "",
      test_count: r.test_request_ids.length,
      attempts: r.attempts,
      gave_up_at: r.resolved_at,
      last_error: r.last_error,
    };
  });
  return { ok: true, abandoned: mapped, waitingForRetry: waiting.count ?? 0, capped: rows.length > STUCK_NOTICE_LIMIT };
}

// Cron Health / sweep-alert counts (counts and timestamps only — no patient data).
// Same admin-client rule as above: call only after an admin gate or from the
// CRON_SECRET-authorised sweep route. Any failed read returns { ok: false } so
// the caller shows "unavailable" rather than a false all-clear.
export type OutboxCountsResult = { ok: true; counts: OutboxCounts } | { ok: false };

export async function fetchOutboxCounts(now: number = Date.now()): Promise<OutboxCountsResult> {
  const admin = createAdminClient();
  const nowIso = new Date(now).toISOString();
  const since = (ms: number) => new Date(now - ms).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  const [queued, overdue, leases, ab24, ab7, sent] = await Promise.all([
    admin.from("release_notices").select("id", { count: "exact", head: true }).in("status", ["pending", "retry"]),
    admin
      .from("release_notices")
      .select("next_attempt_at", { count: "exact" })
      .in("status", ["pending", "retry"])
      .lte("next_attempt_at", nowIso)
      .order("next_attempt_at", { ascending: true })
      .limit(1),
    admin
      .from("release_notices")
      .select("lease_expires_at", { count: "exact" })
      .eq("status", "sending")
      .lt("lease_expires_at", nowIso)
      .order("lease_expires_at", { ascending: true })
      .limit(1),
    onlyLiveAbandoned(admin.from("release_notices").select(COUNT_EMBED, { count: "exact", head: true })).gte("resolved_at", since(DAY)),
    onlyLiveAbandoned(admin.from("release_notices").select(COUNT_EMBED, { count: "exact", head: true })).gte("resolved_at", since(7 * DAY)),
    admin.from("release_notices").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", since(DAY)),
  ]);
  if (queued.error || overdue.error || leases.error || ab24.error || ab7.error || sent.error) return { ok: false };
  return {
    ok: true,
    counts: {
      queued: queued.count ?? 0,
      overdue: overdue.count ?? 0,
      oldestOverdueAt: overdue.data?.[0]?.next_attempt_at ?? null,
      expiredLeases: leases.count ?? 0,
      oldestExpiredLeaseAt: leases.data?.[0]?.lease_expires_at ?? null,
      abandoned24h: ab24.count ?? 0,
      abandoned7d: ab7.count ?? 0,
      sent24h: sent.count ?? 0,
    },
  };
}

/** Dashboard card: how many abandoned notices the Result Follow-ups list would show (exact, not capped). */
export async function fetchAbandonedNoticeCount(): Promise<{ ok: true; count: number } | { ok: false; error: unknown }> {
  const r = await onlyLiveAbandoned(
    createAdminClient().from("release_notices").select(COUNT_EMBED, { count: "exact", head: true }),
  );
  if (r.error) return { ok: false, error: new Error(r.error.message) };
  return { ok: true, count: r.count ?? 0 };
}
