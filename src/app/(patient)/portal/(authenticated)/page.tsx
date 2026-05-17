import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { DownloadButton } from "./download-button";
import { PackageCard, type PackageComponentRow } from "./package-card";

export const metadata = {
  title: "Your results — drmed.ph",
};

// Standalone (non-package) released result, rendered as a row in the
// flat list below the package cards.
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

// Package header surfaced as a card. Components hang off it via
// `components`. The card decides whether the consolidated download is
// available based on `consolidatedAvailable` (every non-cancelled
// component is released AND we have ≥ 1 released component).
interface PackageGroup {
  header: {
    id: string;
    visit_id: string;
    visit_number: string;
    visit_date: string;
    package_name: string;
    package_code: string;
    released_at: string | null;
  };
  components: PackageComponentRow[];
  releasedCount: number;
  totalCount: number;
  consolidatedAvailable: boolean;
}

interface VisitWithPending {
  id: string;
  visit_number: string;
  visit_date: string;
  pending: number;
}

interface PortalData {
  packages: PackageGroup[];
  standalones: ReleasedRow[];
  visitsWithPending: VisitWithPending[];
}

async function loadResults(patientId: string): Promise<PortalData> {
  const admin = createAdminClient();

  // All visits for this patient — used for the "still in progress" hint.
  // Package headers are excluded from the pending count: a header sits
  // in `in_progress` until every component releases, but from the
  // patient's perspective the *components* are what's pending.
  const { data: visits } = await admin
    .from("visits")
    .select(
      `
        id, visit_number, visit_date,
        test_requests ( id, status, is_package_header )
      `,
    )
    .eq("patient_id", patientId)
    .order("visit_date", { ascending: false });

  const visitsWithPending: VisitWithPending[] = [];
  for (const v of visits ?? []) {
    const trs = v.test_requests ?? [];
    const pending = trs.filter(
      (t) =>
        t.is_package_header !== true &&
        t.status !== "released" &&
        t.status !== "cancelled",
    ).length;
    if (pending > 0) {
      visitsWithPending.push({
        id: v.id,
        visit_number: v.visit_number,
        visit_date: v.visit_date,
        pending,
      });
    }
  }

  // Patient-visible test_requests: every released row, plus every
  // package header whose visit belongs to this patient (so the card
  // surfaces even before components release), plus every non-cancelled
  // component of those headers so the card can show progress. We do the
  // patient-id filter via the visits!inner join.
  const { data: trRaw } = await admin
    .from("test_requests")
    .select(
      `
        id, status, released_at, parent_id, is_package_header, created_at,
        services!test_requests_service_id_fkey ( code, name ),
        visits!inner ( id, visit_number, visit_date, patient_id ),
        results ( id )
      `,
    )
    .eq("visits.patient_id", patientId)
    .order("is_package_header", { ascending: false })
    .order("created_at", { ascending: true });

  type TRRow = NonNullable<typeof trRaw>[number];

  // Normalise embedded relations (Supabase types these as
  // single-or-array depending on the relation hint shape).
  function unwrap<T>(v: T | T[] | null | undefined): T | null {
    if (v == null) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }

  const rows = trRaw ?? [];
  const headerRows: TRRow[] = [];
  const componentsByParent = new Map<string, TRRow[]>();
  const standaloneReleased: TRRow[] = [];

  for (const r of rows) {
    const visit = unwrap(r.visits);
    if (!visit || visit.patient_id !== patientId) continue;
    if (r.is_package_header) {
      headerRows.push(r);
    } else if (r.parent_id) {
      const arr = componentsByParent.get(r.parent_id) ?? [];
      arr.push(r);
      componentsByParent.set(r.parent_id, arr);
    } else if (r.status === "released") {
      standaloneReleased.push(r);
    }
  }

  const packages: PackageGroup[] = [];
  for (const h of headerRows) {
    const svc = unwrap(h.services);
    const visit = unwrap(h.visits);
    if (!svc || !visit) continue;
    const rawComps = componentsByParent.get(h.id) ?? [];
    const components: PackageComponentRow[] = rawComps.map((c) => {
      const csvc = unwrap(c.services);
      const cresult = unwrap(c.results);
      return {
        id: c.id,
        status: c.status,
        test_name: csvc?.name ?? "",
        test_code: csvc?.code ?? "",
        has_result: Boolean(cresult),
      };
    });
    const nonCancelled = components.filter((c) => c.status !== "cancelled");
    const released = nonCancelled.filter((c) => c.status === "released");
    packages.push({
      header: {
        id: h.id,
        visit_id: visit.id,
        visit_number: visit.visit_number,
        visit_date: visit.visit_date,
        package_name: svc.name,
        package_code: svc.code,
        released_at: h.released_at,
      },
      components,
      releasedCount: released.length,
      totalCount: nonCancelled.length,
      consolidatedAvailable:
        h.status === "released" &&
        nonCancelled.length > 0 &&
        released.length === nonCancelled.length,
    });
  }

  const standalones: ReleasedRow[] = [];
  for (const r of standaloneReleased) {
    const svc = unwrap(r.services);
    const visit = unwrap(r.visits);
    const result = unwrap(r.results);
    if (!svc || !visit) continue;
    standalones.push({
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
  // Newest standalones first to match prior behaviour.
  standalones.sort((a, b) => {
    const ar = a.released_at ?? "";
    const br = b.released_at ?? "";
    return br.localeCompare(ar);
  });

  return { packages, standalones, visitsWithPending };
}

export default async function PatientPortalPage() {
  const patient = await requirePatientProfile();
  const { packages, standalones, visitsWithPending } = await loadResults(
    patient.patient_id,
  );

  const nothingToShow = packages.length === 0 && standalones.length === 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Your results
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Released laboratory results, newest first. Tap Download to get the
        official signed PDF.
      </p>

      {packages.length > 0 ? (
        <section className="mt-6">
          <h2 className="sr-only">Packages</h2>
          {packages.map((pkg) => (
            <PackageCard
              key={pkg.header.id}
              header={pkg.header}
              components={pkg.components}
              releasedCount={pkg.releasedCount}
              totalCount={pkg.totalCount}
              consolidatedAvailable={pkg.consolidatedAvailable}
            />
          ))}
        </section>
      ) : null}

      <div className="mt-6 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[560px] text-sm">
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
            {standalones.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {nothingToShow ? (
                    <>
                      No released results yet. We&apos;ll text and email you
                      when they&apos;re ready.
                    </>
                  ) : (
                    <>
                      No individual results — your released results are grouped
                      into the package cards above.
                    </>
                  )}
                </td>
              </tr>
            ) : (
              standalones.map((row) => (
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
