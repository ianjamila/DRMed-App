import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { DownloadButton } from "../../download-button";

export const metadata = {
  title: "Visit — drmed.ph",
};

interface Props {
  params: Promise<{ id: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  in_progress: "In progress",
  result_uploaded: "Awaiting sign-off",
  ready_for_release: "Ready for release",
  released: "Released",
  cancelled: "Cancelled",
};

const RELEASED_STATUS_STYLE = "bg-emerald-100 text-emerald-900";
const PENDING_STATUS_STYLE = "bg-slate-200 text-slate-700";

export default async function PatientVisitDetailPage({ params }: Props) {
  const { id } = await params;
  const patient = await requirePatientProfile();
  const admin = createAdminClient();

  const { data: visit } = await admin
    .from("visits")
    .select(
      `
        id, patient_id, visit_number, visit_date, payment_status,
        test_requests (
          id, status, released_at,
          services!inner ( name, code ),
          results ( id )
        )
      `,
    )
    .eq("id", id)
    .eq("patient_id", patient.patient_id)
    .maybeSingle();

  if (!visit) notFound();

  // Patients only see released tests per the plan; group counts for context.
  const releasedTests = (visit.test_requests ?? []).filter(
    (t) => t.status === "released",
  );
  const pendingCount = (visit.test_requests ?? []).filter(
    (t) => t.status !== "released" && t.status !== "cancelled",
  ).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/portal"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← All results
      </Link>
      <header className="mt-3">
        <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">
          Visit #{visit.visit_number}
        </p>
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {new Date(visit.visit_date).toLocaleDateString("en-PH", {
            dateStyle: "long",
          })}
        </h1>
      </header>

      <div className="mt-6 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
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
                const result = Array.isArray(t.results) ? t.results[0] : t.results;
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
                        ? new Date(t.released_at).toLocaleDateString("en-PH")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${RELEASED_STATUS_STYLE}`}
                      >
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {result ? (
                        <DownloadButton testRequestId={t.id} />
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
      </div>

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
