import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { fetchOutdatedCopies, type OutdatedCopyRow } from "@/lib/results/copy-followups.server";
import { copyKindLabel, followUpStatusLabel } from "@/lib/results/copy-followups";
import { manilaDateTime } from "@/lib/dates/manila";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { PlainTh } from "@/components/staff/sortable-th";
import { MarkContactedButton } from "./mark-contacted-button";

export const metadata = {
  title: "Result Follow-ups",
};

const BASE_PATH = "/staff/result-follow-ups";

interface SearchProps {
  searchParams: Promise<{ all?: string }>;
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

  const toggleHref = includeAll ? BASE_PATH : `${BASE_PATH}?all=1`;

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
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!row.followed_up && row.latest_amendment_id ? (
                        <MarkContactedButton amendmentId={row.latest_amendment_id} />
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
