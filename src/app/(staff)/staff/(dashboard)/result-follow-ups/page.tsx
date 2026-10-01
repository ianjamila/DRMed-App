import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { fetchOutdatedCopies, type OutdatedCopyRow } from "@/lib/results/copy-followups.server";
import {
  RETRY_OUTCOME_TEXT,
  canRetryNotice,
  copyKindLabel,
  followUpStatusLabel,
  notifyProblemHint,
} from "@/lib/results/copy-followups";
import { manilaDateTime } from "@/lib/dates/manila";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { PlainTh } from "@/components/staff/sortable-th";
import { emailStatus, patientNoticeSetupNote, smsStatus } from "@/lib/notifications/channel-status";
import { MarkContactedButton } from "./mark-contacted-button";
import { RetryNoticeButton } from "./retry-notice-button";
import { RetryReleaseNoticeButton } from "./retry-release-notice-button";
import { fetchStuckNotices } from "@/lib/results/release-notice-followups.server";

export const metadata = {
  title: "Result Follow-ups",
};

const BASE_PATH = "/staff/result-follow-ups";

interface SearchProps {
  searchParams: Promise<{ all?: string; retried?: string; noticeRetried?: string }>;
}

function statusText(row: OutdatedCopyRow): string {
  const base = followUpStatusLabel(row);
  return row.contacted_at && row.contacted_by_name ? `${base} by ${row.contacted_by_name}` : base;
}

export default async function ResultFollowUpsPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    notFound();
  }

  const params = await searchParams;
  const includeAll = params.all === "1";

  const db = await createClient();
  const result = await fetchOutdatedCopies(db, includeAll);
  // 0210/0212: "result ready" messages the sender gave up on (service-role read,
  // after the role gate above; names and states only, never an address).
  const stuck = await fetchStuckNotices();
  const isAdmin = session.role === "admin";

  const toggleHref = includeAll ? BASE_PATH : `${BASE_PATH}?all=1`;
  // 0188: the Retry notice outcome, carried in the URL by RetryNoticeButton
  // (a successful retry takes its row off the list). Only known outcomes
  // render — anything else in the URL is ignored.
  // 0188: say up front when a channel can't send here, before a notice fails.
  const setupNote = patientNoticeSetupNote(emailStatus(), smsStatus());
  const retried =
    typeof params.retried === "string" && Object.hasOwn(RETRY_OUTCOME_TEXT, params.retried)
      ? RETRY_OUTCOME_TEXT[params.retried]
      : null;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Result Follow-ups"
        subtitle="Patients holding a copy of a result that was corrected afterwards — call them or mark them contacted."
      />

      <p className="mb-4 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
        Lists patients who downloaded or were handed a result before it was
        corrected. Reasons for corrections are not shown here.
      </p>

      {setupNote ? (
        <p
          role="note"
          className="mb-4 max-w-2xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800"
        >
          {setupNote}
          {session.role === "admin" ? (
            <>
              {" "}
              <Link href="/staff/admin/settings/alerts" className="font-semibold underline">
                See Email Alerts
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {retried ? (
        <p
          role="status"
          className={`mb-4 max-w-2xl rounded-lg border px-4 py-2 text-sm font-semibold ${
            params.retried === "sent"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          Retry notice: {retried}
        </p>
      ) : null}

      {params.noticeRetried === "1" ? (
        <p
          role="status"
          className="mb-4 max-w-2xl rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800"
        >
          Queued — the message will be sent again within a few minutes.
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          href={toggleHref}
          aria-pressed={includeAll}
          className={`min-h-11 inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
            includeAll
              ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
              : "border-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-text-soft)] hover:border-[color:var(--color-brand-cyan)]"
          }`}
        >
          {includeAll ? "Hide followed-up" : "Show followed-up"}
        </Link>
      </div>

      {!result.ok ? (
        <Panel className="p-6 text-sm text-amber-700">Couldn&apos;t load follow-ups.</Panel>
      ) : (
        <Panel className="overflow-x-auto">
          {result.capped ? (
            <p role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800">
              Showing the first 1000 — mark some as contacted to see the rest.
            </p>
          ) : null}
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <PlainTh label="Patient" />
                <PlainTh label="Phone" />
                <PlainTh label="Test" />
                <PlainTh label="Corrected" />
                <PlainTh label="Copy" />
                <PlainTh label="Status" />
                <PlainTh label="Action" align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {result.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No patients are holding an out-of-date copy.
                  </td>
                </tr>
              ) : (
                result.rows.map((row) => (
                  <tr key={row.result_id} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/visits/${row.visit_id}`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {row.patient_name}
                      </Link>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {row.drm_id}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {row.phone || "—"}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {row.test_names}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {manilaDateTime(row.amended_at)}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {copyKindLabel(row)}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {statusText(row)}
                      {notifyProblemHint(row) ? (
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          {notifyProblemHint(row)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!row.followed_up && row.latest_amendment_id ? (
                        <div className="flex flex-col items-end gap-2">
                          {canRetryNotice(row) ? (
                            <RetryNoticeButton amendmentId={row.latest_amendment_id} showingAll={includeAll} />
                          ) : null}
                          <MarkContactedButton amendmentId={row.latest_amendment_id} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      )}

      {/* 0210/0212: the patient's "your result is ready" message that never went out. */}
      {!stuck.ok ? (
        <Panel className="mt-8 p-6 text-sm text-amber-700">Couldn&apos;t load unsent result messages.</Panel>
      ) : stuck.abandoned.length > 0 || stuck.waitingForRetry > 0 ? (
        <section aria-labelledby="unsent-notices-heading" className="mt-8">
          <h2
            id="unsent-notices-heading"
            className="mb-1 text-lg font-bold text-[color:var(--color-brand-navy)]"
          >
            Result-ready messages that did not go out
          </h2>
          <p className="mb-3 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            The system retries a failed message by itself over several hours. These are the ones it gave up on — the
            patient has not been told their result is ready.
            {isAdmin ? " Retry sending after the problem is fixed, or call the patient." : " Ask an admin to retry, or call the patient."}
            {stuck.waitingForRetry > 0
              ? ` ${stuck.waitingForRetry} more ${stuck.waitingForRetry === 1 ? "is" : "are"} still waiting for an automatic retry.`
              : ""}
          </p>
          {stuck.abandoned.length > 0 ? (
            <Panel className="overflow-x-auto">
              {stuck.capped ? (
                <p role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800">
                  Showing the most recent {stuck.abandoned.length}.
                </p>
              ) : null}
              <table className="w-full text-sm">
                <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    <PlainTh label="Patient" />
                    <PlainTh label="Visit" />
                    <PlainTh label="Tests" />
                    <PlainTh label="Gave up" />
                    <PlainTh label="Problem" />
                    {isAdmin ? <PlainTh label="Action" align="right" /> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                  {stuck.abandoned.map((n) => (
                    <tr key={n.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/visits/${n.visit_id}`}
                          className="font-semibold text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {n.patient_name}
                        </Link>
                        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">{n.drm_id}</p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                        {n.visit_number || "—"}
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">{n.test_count}</td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                        {n.gave_up_at ? manilaDateTime(n.gave_up_at) : "—"}
                        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                          after {n.attempts} {n.attempts === 1 ? "try" : "tries"}
                        </p>
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                        {n.last_error ?? "—"}
                      </td>
                      {isAdmin ? (
                        <td className="px-4 py-3 text-right">
                          <RetryReleaseNoticeButton noticeId={n.id} showingAll={includeAll} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
