import Link from "next/link";
import { notFound } from "next/navigation";
import { createPatientClient } from "@/lib/supabase/patient";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { DownloadButton } from "../../download-button";
import { ResultUpdatedBadge } from "../../result-updated-badge";
import { isUpdatedSinceDownload } from "@/lib/results/patient-update-marker";
import { Panel } from "@/components/ui/panel";
import { manilaDate, manilaLongDate } from "@/lib/dates/manila";
import { testStatusLabel } from "@/lib/results/status-filter";

export const metadata = {
  title: "Visit",
};

interface Props {
  params: Promise<{ id: string }>;
}

const RELEASED_STATUS_STYLE = "bg-emerald-100 text-emerald-900";
const PENDING_STATUS_STYLE = "bg-[color:var(--color-brand-bg-mid)] text-[color:var(--color-brand-text-soft)]";

export default async function PatientVisitDetailPage({ params }: Props) {
  const { id } = await params;
  const patient = await requirePatientProfile();
  // Patient-scoped client — visits/test_requests/results RLS enforces ownership
  // and released-only visibility; the .eq("patient_id", …) filter stays as
  // defense-in-depth. A visit id that isn't the patient's now returns no row
  // (RLS-backed) → notFound(), not just an app-level filter miss.
  const db = await createPatientClient(patient.patient_id);

  const { data: visitRaw } = await db
    .from("visits")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("id, patient_id, visit_number, visit_date, payment_status, test_requests(id, status, released_at, deleted_at, legacy_import_run_id, services!inner(name, code), result_test_requests(result_id, results!inner(id, storage_path, amended_at, patient_last_downloaded_at)))" as any)
    .eq("id", id)
    .eq("patient_id", patient.patient_id)
    // Queue-deleted visits (0125) are not part of the patient's record view.
    .is("deleted_at", null)
    .maybeSingle();

  if (!visitRaw) notFound();

  type TrWithResult = {
    id: string;
    status: string;
    released_at: string | null;
    deleted_at: string | null;
    legacy_import_run_id: string | null;
    services: { name: string; code: string } | { name: string; code: string }[] | null;
    result_test_requests: {
      result_id: string;
      results: {
        id: string;
        storage_path: string | null;
        amended_at: string | null;
        patient_last_downloaded_at: string | null;
      } | null;
    }[] | null;
  };
  type VisitShape = {
    id: string;
    patient_id: string;
    visit_number: string;
    visit_date: string;
    payment_status: string;
    test_requests: TrWithResult[] | null;
  };
  const visit = visitRaw as unknown as VisitShape;

  // Patients only see released tests per the plan; group counts for context.
  // Queue-deleted lines (0125) are neither released nor pending — invisible.
  const activeTests = (visit.test_requests ?? []).filter(
    (t) => t.deleted_at === null,
  );
  const releasedTests = activeTests.filter((t) => t.status === "released");
  const pendingCount = activeTests.filter(
    (t) => t.status !== "released" && t.status !== "cancelled",
  ).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/portal"
        className="link-brand text-xs font-bold uppercase tracking-wider"
      >
        ← All results
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">
            Visit #{visit.visit_number}
          </p>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {manilaLongDate(visit.visit_date)}
          </h1>
        </div>
        {/* What the visit cost and what was paid — for an HMO or employer
            reimbursement, without a trip back to the counter. */}
        <Link
          href={`/portal/visits/${visit.id}/statement`}
          className="inline-flex min-h-[44px] items-center rounded-md border border-[color:var(--color-brand-navy)] px-4 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          Statement of account
        </Link>
      </header>

      <Panel className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3">Released</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {releasedTests.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No released tests for this visit yet.
                </td>
              </tr>
            ) : (
              releasedTests.map((t) => {
                const svc = Array.isArray(t.services) ? t.services[0] : t.services;
                const rtrs = Array.isArray(t.result_test_requests) ? t.result_test_requests : [];
                const rtr = rtrs[0] ?? null;
                const result = rtr
                  ? (Array.isArray(rtr.results) ? rtr.results[0] : rtr.results)
                  : null;
                if (!svc) return null;
                return (
                  <tr key={t.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {svc.name}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {svc.code}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {t.released_at
                        ? manilaDate(t.released_at)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${RELEASED_STATUS_STYLE}`}
                      >
                        {testStatusLabel(t.status)}
                      </span>
                      {result?.storage_path && isUpdatedSinceDownload(result) ? (
                        <div className="mt-1">
                          <ResultUpdatedBadge show />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {result?.storage_path ? (
                        <DownloadButton testRequestId={t.id} />
                      ) : t.legacy_import_run_id ? (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          Released —{" "}
                          <span className="block sm:inline">
                            pre-system record (no digital copy on file)
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          No file
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      {pendingCount > 0 ? (
        <p className="mt-4 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-4 text-sm text-[color:var(--color-brand-text-mid)]">
          <span
            className={`mr-2 rounded-md px-2 py-0.5 text-xs font-semibold ${PENDING_STATUS_STYLE}`}
          >
            {pendingCount} pending
          </span>
          Some tests on this visit are still being processed. We&apos;ll
          notify you when each one is released.
        </p>
      ) : null}
    </div>
  );
}
