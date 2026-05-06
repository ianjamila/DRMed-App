import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { DownloadButton } from "./download-button";

export const metadata = {
  title: "Your results — drmed.ph",
};

interface ReleasedRow {
  test_request_id: string;
  visit_id: string;
  visit_number: string;
  test_name: string;
  test_code: string;
  test_date: string;
  released_at: string | null;
  has_result: boolean;
}

interface VisitWithPending {
  id: string;
  visit_number: string;
  visit_date: string;
  pending: number;
}

async function loadReleasedResults(patientId: string): Promise<{
  released: ReleasedRow[];
  visitsWithPending: VisitWithPending[];
}> {
  const admin = createAdminClient();

  // All visits for this patient — used for the "still in progress" hint.
  const { data: visits } = await admin
    .from("visits")
    .select(
      `
        id, visit_number, visit_date,
        test_requests ( id, status )
      `,
    )
    .eq("patient_id", patientId)
    .order("visit_date", { ascending: false });

  const visitsWithPending: VisitWithPending[] = [];
  for (const v of visits ?? []) {
    const trs = v.test_requests ?? [];
    const pending = trs.filter((t) => t.status !== "released" && t.status !== "cancelled").length;
    if (pending > 0) {
      visitsWithPending.push({
        id: v.id,
        visit_number: v.visit_number,
        visit_date: v.visit_date,
        pending,
      });
    }
  }

  // Released results, flat, newest first.
  const { data: releasedRaw } = await admin
    .from("test_requests")
    .select(
      `
        id, released_at,
        services!inner ( name, code ),
        visits!inner ( id, visit_number, visit_date, patient_id ),
        results ( id )
      `,
    )
    .eq("status", "released")
    .order("released_at", { ascending: false });

  const released: ReleasedRow[] = [];
  for (const r of releasedRaw ?? []) {
    const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const result = Array.isArray(r.results) ? r.results[0] : r.results;
    if (!visit || visit.patient_id !== patientId || !svc) continue;
    released.push({
      test_request_id: r.id,
      visit_id: visit.id,
      visit_number: visit.visit_number,
      test_name: svc.name,
      test_code: svc.code,
      test_date: visit.visit_date,
      released_at: r.released_at,
      has_result: Boolean(result),
    });
  }

  return { released, visitsWithPending };
}

export default async function PatientPortalPage() {
  const patient = await requirePatientProfile();
  const { released, visitsWithPending } = await loadReleasedResults(
    patient.patient_id,
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Your results
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Released laboratory results, newest first. Tap Download to get the
        official signed PDF.
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Visit #</th>
              <th className="px-4 py-3">Test</th>
              <th className="px-4 py-3">Test date</th>
              <th className="px-4 py-3">Released</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {released.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No released results yet. We&apos;ll text and email you when
                  they&apos;re ready.
                </td>
              </tr>
            ) : (
              released.map((row) => (
                <tr
                  key={row.test_request_id}
                  className="hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 font-mono text-[color:var(--color-brand-text-mid)]">
                    <Link
                      href={`/portal/visits/${row.visit_id}`}
                      className="hover:text-[color:var(--color-brand-cyan)]"
                    >
                      #{row.visit_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {row.test_name}
                    </p>
                    <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {row.test_code}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {new Date(row.test_date).toLocaleDateString("en-PH")}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {row.released_at
                      ? new Date(row.released_at).toLocaleDateString("en-PH")
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                      Released
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.has_result ? (
                      <DownloadButton testRequestId={row.test_request_id} />
                    ) : (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        No file
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {visitsWithPending.length > 0 ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Still in progress
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            These visits have tests that haven&apos;t been released yet.
          </p>
          <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] text-sm">
            {visitsWithPending.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between py-2"
              >
                <Link
                  href={`/portal/visits/${v.id}`}
                  className="font-mono font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]"
                >
                  Visit #{v.visit_number}
                </Link>
                <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {new Date(v.visit_date).toLocaleDateString("en-PH")} ·{" "}
                  {v.pending} test{v.pending === 1 ? "" : "s"} pending
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
        <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Download a copy of your data
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Under the Philippine Data Privacy Act (RA 10173) you have the
          right to a copy of the data we hold about you. The export
          includes your contact info, visits, payments, appointments, and
          all your released result PDFs in a single ZIP.
        </p>
        <a
          href="/portal/data-export"
          className="mt-3 inline-block rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Download my data (ZIP)
        </a>
      </section>

      <p className="mt-8 text-xs text-[color:var(--color-brand-text-soft)]">
        🔒 Each download generates a 5-minute one-time link and is logged for
        compliance. Don&apos;t share your DRM-ID or PIN with anyone.
      </p>
    </div>
  );
}
