import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { DownloadButton } from "./download-button";
import { PackageCard, type PackageComponentRow } from "./package-card";
import { LabRequestUploads, type UploadRow } from "./lab-request-uploads";
import { Panel } from "@/components/ui/panel";
import { reviewLink } from "@/lib/seo/review";

export const metadata = {
  title: "Your results — drmed.ph",
};

// Standalone (non-package) released result, rendered as a row in the
// flat list below the package cards.
//
// For consolidated (grouped) results, `result_id` is the `results.id`
// used for downloads; `primary_label` is the group name (e.g. "Chemistry")
// and `sub_label` lists the individual test names.
interface ReleasedRow {
  /** Used for the download action — may be a standalone test_request_id
   *  (single result) or a results.id (consolidated). */
  result_key: string;
  /** True when `result_key` is a `results.id` (consolidated path). */
  is_consolidated: boolean;
  visit_id: string;
  visit_number: string;
  primary_label: string;
  sub_label: string | null;
  test_code: string | null;
  test_date: string;
  released_at: string | null;
  has_result: boolean;
  /** True when this row came from the historical backfill (legacy_import_run_id IS NOT NULL).
   *  Used to show a more informative label when no digital copy exists. */
  is_legacy: boolean;
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
        legacy_import_run_id,
        services!test_requests_service_id_fkey ( code, name ),
        visits!inner ( id, visit_number, visit_date, patient_id )
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

  // Batch-lookup which component test_request_ids have a result (via junction).
  const allComponentIds = [...componentsByParent.values()]
    .flat()
    .map((c) => c.id);
  const componentResultSet = new Set<string>();
  if (allComponentIds.length > 0) {
    const { data: compJunctionsRaw } = await admin
      .from("result_test_requests")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("test_request_id, results!inner(storage_path)" as any)
      .in("test_request_id", allComponentIds);
    type CompJunction = { test_request_id: string; results: { storage_path: string | null } | null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compJunctions = (compJunctionsRaw as any as CompJunction[]) ?? [];
    for (const j of compJunctions) {
      const r = Array.isArray(j.results) ? j.results[0] : j.results;
      if (r?.storage_path) {
        componentResultSet.add(j.test_request_id);
      }
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
      return {
        id: c.id,
        status: c.status,
        test_name: csvc?.name ?? "",
        test_code: csvc?.code ?? "",
        has_result: componentResultSet.has(c.id),
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

  // ------------------------------------------------------------------
  // Standalones: released test_requests that are not package headers or
  // package components. We look up results via result_test_requests and
  // group by result_id so consolidated reports (multiple tests sharing
  // one result row) appear as a single card.
  // ------------------------------------------------------------------

  // Derive label for a result row.
  function labelForResult(
    reportGroupName: string | null,
    testNames: string[],
    singleServiceName: string | null,
    singleServiceCode: string | null,
  ): { primary: string; sub: string | null; code: string | null } {
    if (reportGroupName) {
      const sub = testNames.filter(Boolean).join(", ");
      return { primary: reportGroupName, sub: sub || null, code: null };
    }
    return {
      primary: singleServiceName ?? "Result",
      sub: null,
      code: singleServiceCode,
    };
  }

  const standaloneIds = standaloneReleased.map((r) => r.id);
  // Build a quick lookup: test_request_id → TRRow
  const trById = new Map(standaloneReleased.map((r) => [r.id, r]));

  const standalones: ReleasedRow[] = [];
  if (standaloneIds.length > 0) {
    // Walk result_test_requests to find which results cover these test_requests.
    const { data: junctionsRaw } = await admin
      .from("result_test_requests")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("result_id, test_request_id, results!inner(id, storage_path, report_group_id, report_groups(name))" as any)
      .in("test_request_id", standaloneIds);

    type JRow = {
      result_id: string;
      test_request_id: string;
      results: {
        id: string;
        storage_path: string | null;
        report_group_id: string | null;
        report_groups: { name: string } | null;
      } | null;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const junctions = (junctionsRaw as any as JRow[]) ?? [];

    // Group junction rows by result_id.
    const byResultId = new Map<string, JRow[]>();
    for (const j of junctions) {
      const rid = j.result_id;
      const arr = byResultId.get(rid) ?? [];
      arr.push(j);
      byResultId.set(rid, arr);
    }

    // Also track which test_request_ids were covered by a result (so we
    // can surface test_requests with no result row as has_result=false).
    const coveredTrIds = new Set(junctions.map((j) => j.test_request_id));

    // Build ReleasedRow for each result group.
    for (const [, jRows] of byResultId) {
      const firstJ = jRows[0];
      const result = Array.isArray(firstJ.results)
        ? firstJ.results[0]
        : firstJ.results;
      if (!result) continue;

      // Find one of the linked TRRows to derive visit info.
      const anyTrRow = trById.get(firstJ.test_request_id);
      if (!anyTrRow) continue;
      const visit = unwrap(anyTrRow.visits);
      if (!visit) continue;

      // Earliest released_at among linked test_requests.
      const releasedAt =
        jRows
          .map((j) => trById.get(j.test_request_id)?.released_at ?? null)
          .filter((d): d is string => d !== null)
          .sort()
          .at(0) ?? null;

      const isConsolidated = Boolean(result.report_group_id);
      const reportGroupName = result.report_groups?.name ?? null;
      const testNames = jRows
        .map((j) => {
          const tr = trById.get(j.test_request_id);
          const svc = tr ? unwrap(tr.services) : null;
          return svc?.name ?? null;
        })
        .filter((n): n is string => n !== null);

      const firstSvc = unwrap(anyTrRow.services);
      const { primary, sub, code } = labelForResult(
        reportGroupName,
        testNames,
        firstSvc?.name ?? null,
        firstSvc?.code ?? null,
      );

      standalones.push({
        result_key: isConsolidated ? result.id : firstJ.test_request_id,
        is_consolidated: isConsolidated,
        visit_id: visit.id,
        visit_number: visit.visit_number,
        primary_label: primary,
        sub_label: sub,
        test_code: code,
        test_date: visit.visit_date,
        released_at: releasedAt,
        has_result: Boolean(result.storage_path),
        // A result row exists but has no storage_path — not a legacy concern.
        is_legacy: false,
      });
    }

    // Add test_requests with no result row yet (has_result=false).
    for (const tr of standaloneReleased) {
      if (coveredTrIds.has(tr.id)) continue;
      const visit = unwrap(tr.visits);
      const svc = unwrap(tr.services);
      if (!visit) continue;
      standalones.push({
        result_key: tr.id,
        is_consolidated: false,
        visit_id: visit.id,
        visit_number: visit.visit_number,
        primary_label: svc?.name ?? "Result",
        sub_label: null,
        test_code: svc?.code ?? null,
        test_date: visit.visit_date,
        released_at: tr.released_at,
        has_result: false,
        is_legacy: Boolean(tr.legacy_import_run_id),
      });
    }
  }

  // Newest standalones first to match prior behaviour.
  standalones.sort((a, b) => {
    const ar = a.released_at ?? "";
    const br = b.released_at ?? "";
    return br.localeCompare(ar);
  });

  return { packages, standalones, visitsWithPending };
}

async function loadUploads(patientId: string): Promise<UploadRow[]> {
  const admin = createAdminClient();
  const { data: atts } = await admin
    .from("appointment_attachments")
    .select("id, booking_group_id, filename, mime_type, size_bytes, created_at, storage_path")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false });

  if (!atts || atts.length === 0) return [];

  // Representative appointment per booking_group_id, for a context label.
  const groupIds = [...new Set(atts.map((a) => a.booking_group_id))];
  const { data: appts } = await admin
    .from("appointments")
    .select("booking_group_id, scheduled_at, services ( name )")
    .in("booking_group_id", groupIds);

  const contextByGroup = new Map<string, string>();
  for (const ap of appts ?? []) {
    if (!ap.booking_group_id) continue;
    const svc = Array.isArray(ap.services) ? ap.services[0] : ap.services;
    const name = svc?.name ?? "Lab request";
    const when = ap.scheduled_at
      ? new Date(ap.scheduled_at).toLocaleDateString("en-PH", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
    const label = when ? `${name} · ${when}` : name;
    // Prefer a row that carries a scheduled time over a barer one.
    if (!contextByGroup.has(ap.booking_group_id) || when) {
      contextByGroup.set(ap.booking_group_id, label);
    }
  }

  const IMG = new Set(["image/jpeg", "image/png", "image/webp"]);
  const rows: UploadRow[] = [];
  for (const a of atts) {
    let thumbUrl: string | null = null;
    if (IMG.has(a.mime_type)) {
      const { data: signed } = await admin.storage
        .from("lab-request-forms")
        .createSignedUrl(a.storage_path, 60 * 5);
      thumbUrl = signed?.signedUrl ?? null;
    }
    rows.push({
      id: a.id,
      filename: a.filename,
      isPdf: a.mime_type === "application/pdf",
      thumbUrl,
      contextLabel: contextByGroup.get(a.booking_group_id) ?? null,
      createdAt: a.created_at,
    });
  }
  return rows;
}

export default async function PatientPortalPage() {
  const patient = await requirePatientProfile();
  const { packages, standalones, visitsWithPending } = await loadResults(
    patient.patient_id,
  );
  const uploads = await loadUploads(patient.patient_id);

  const nothingToShow = packages.length === 0 && standalones.length === 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
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

      {/* Desktop / tablet: scrollable table */}
      <Panel className="mt-6 hidden overflow-x-auto sm:block">
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
                      No released results yet. We&apos;ll email you
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
                  key={row.result_key}
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
                      {row.primary_label}
                    </p>
                    {row.sub_label ? (
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {row.sub_label}
                      </p>
                    ) : row.test_code ? (
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {row.test_code}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {new Date(row.test_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {row.released_at
                      ? new Date(row.released_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                      Released
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.has_result ? (
                      <DownloadButton
                        testRequestId={row.is_consolidated ? undefined : row.result_key}
                        resultId={row.is_consolidated ? row.result_key : undefined}
                      />
                    ) : row.is_legacy ? (
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
              ))
            )}
          </tbody>
        </table>
      </Panel>

      {/* Mobile: stacked cards (same rows as the table above) */}
      <div className="mt-6 sm:hidden">
        {standalones.length === 0 ? (
          <Panel className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            {nothingToShow ? (
              <>
                No released results yet. We&apos;ll email you when
                they&apos;re ready.
              </>
            ) : (
              <>
                No individual results — your released results are grouped into
                the package cards above.
              </>
            )}
          </Panel>
        ) : (
          <ul className="space-y-3">
            {standalones.map((row) => (
              <li
                key={row.result_key}
                className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {row.primary_label}
                    </p>
                    {row.sub_label ? (
                      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                        {row.sub_label}
                      </p>
                    ) : row.test_code ? (
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {row.test_code}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                    Released
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-[color:var(--color-brand-text-soft)]">
                  <Link
                    href={`/portal/visits/${row.visit_id}`}
                    className="font-mono hover:text-[color:var(--color-brand-cyan)]"
                  >
                    #{row.visit_number}
                  </Link>
                  <span>
                    {new Date(row.test_date).toLocaleDateString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}
                  </span>
                </div>
                <div className="mt-3">
                  {row.has_result ? (
                    <DownloadButton
                      testRequestId={
                        row.is_consolidated ? undefined : row.result_key
                      }
                      resultId={row.is_consolidated ? row.result_key : undefined}
                    />
                  ) : row.is_legacy ? (
                    <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                      Released —{" "}
                      pre-system record (no digital copy on file)
                    </span>
                  ) : (
                    <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                      No file
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!nothingToShow ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Enjoying DRMed?
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            A quick Google review helps other families find trustworthy,
            affordable care.
          </p>
          <a
            href={reviewLink("portal")}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Leave us a Google review
          </a>
        </section>
      ) : null}

      {visitsWithPending.length > 0 ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
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
                  {new Date(v.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })} ·{" "}
                  {v.pending} test{v.pending === 1 ? "" : "s"} pending
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {uploads.length > 0 ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Your uploaded request forms
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            The doctor&apos;s request form(s) you attached when booking. Tap View
            for a 5-minute secure link.
          </p>
          <LabRequestUploads rows={uploads} />
        </section>
      ) : null}

      <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
        <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
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
