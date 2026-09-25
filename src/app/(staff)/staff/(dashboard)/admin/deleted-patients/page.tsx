import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import { ExportCsvLink } from "@/components/staff/export-csv-link";
import { RestorePatientButton } from "@/components/staff/restore-patient-button";
import {
  ariaSortFor,
  buildListHref,
  DEFAULT_PAGE_SIZE,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { formatPatientName } from "@/lib/patients/format-name";
import { deleteReasonLabel, keptSummary, parseKeptCounts } from "@/lib/patients/deletion";
import { manilaDate } from "@/lib/dates/manila";
import {
  DELETED_SORTABLE,
  loadDeletedPatientsPage,
  type DeletedPatientRow,
  type DeletedSortColumn,
} from "@/lib/reports/deleted-patients";

export const metadata = { title: "Deleted Patients" };

const BASE_PATH = "/staff/admin/deleted-patients";
const DEFAULT_SORT: SortSpec<DeletedSortColumn> = { key: "deleted_at", dir: "desc" };

interface Props {
  searchParams: Promise<{ sort?: string; dir?: string; page?: string; size?: string }>;
}

export default async function DeletedPatientsPage({ searchParams }: Props) {
  await requireAdminStaff();
  const params = await searchParams;
  const sort = parseSort(params.sort, params.dir, DELETED_SORTABLE, DEFAULT_SORT);
  const size = parsePageSize(params.size);
  const page = parsePage(params.page);
  const [from, to] = rangeFor(page, size);

  const supabase = await createClient();
  const { rows, total, error } = await loadDeletedPatientsPage(supabase, { sort, from, to });
  const totalPages = pageCount(total, size);

  // Display enrichment only (never sort/filter/page input). service_role RPC,
  // called after the admin gate above. An RPC error must not read as "kept
  // nothing" — the row shows "—" instead of a false zero.
  const kept = new Map<string, ReturnType<typeof parseKeptCounts>>();
  let keptCountsFailed = false;
  if (rows.length > 0) {
    const { data: counts, error: keptErr } = await createAdminClient().rpc("patient_kept_counts", {
      p_patient_ids: rows.map((r) => r.id),
    });
    if (keptErr) {
      keptCountsFailed = true;
    } else {
      for (const c of counts ?? []) kept.set(c.patient_id, parseKeptCounts(c));
    }
  }

  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === DEFAULT_PAGE_SIZE ? null : String(size),
  };
  const sortHref = (key: DeletedSortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return buildListHref(BASE_PATH, baseParams, {
      sort: nextIsDefault ? null : next.key,
      dir: nextIsDefault ? null : next.dir,
      page: null,
    });
  };
  const th = (key: DeletedSortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Deleted Patients"
        subtitle="Records an admin deleted. Their visits, payments and results stay on file; restoring puts the record back everywhere."
        actions={
          <ExportCsvLink
            href={buildListHref("/api/admin/reports/deleted-patients.csv", { sort: sort.key, dir: sort.dir })}
          />
        }
      />
      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Could not load deleted patients. Refresh the page.
        </p>
      ) : null}
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {th("drm_id", "DRM-ID")}
              {th("last_name", "Name")}
              {th("deleted_at", "Deleted on")}
              {th("deleted_by_name", "Deleted by")}
              <PlainTh label="Reason" />
              <PlainTh label="On file" />
              <PlainTh label="" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
                  No deleted patient records.
                </td>
              </tr>
            ) : (
              rows.map((r: DeletedPatientRow) => (
                <tr key={r.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 font-mono">
                    <Link href={`/staff/patients/${r.id}`} className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]">
                      {r.drm_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{formatPatientName(r) || "(no name on file)"}</td>
                  <td className="px-4 py-3">{manilaDate(r.deleted_at)}</td>
                  <td className="px-4 py-3">{r.deleted_by_name ?? "—"}</td>
                  <td className="px-4 py-3">
                    {deleteReasonLabel(r.delete_reason)}
                    {r.delete_note ? (
                      <span className="block text-xs text-[color:var(--color-brand-text-soft)]">{r.delete_note}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                    {keptCountsFailed ? "—" : keptSummary(kept.get(r.id) ?? parseKeptCounts(null))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RestorePatientButton patientId={r.id} drmId={r.drm_id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>
      <ListPagination
        page={page}
        pageCount={totalPages}
        total={total}
        size={size}
        prevHref={page > 1 ? buildListHref(BASE_PATH, baseParams, { page: page - 1 > 1 ? String(page - 1) : null }) : null}
        nextHref={page < totalPages ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) }) : null}
        sizeOptions={PAGE_SIZES.map((s) => ({
          size: s,
          href: buildListHref(BASE_PATH, baseParams, { size: s === DEFAULT_PAGE_SIZE ? null : String(s), page: null }),
        }))}
        noun="deleted patient"
      />
    </div>
  );
}
