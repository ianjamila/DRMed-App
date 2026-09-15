import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { PageHeader } from "@/components/staff/page-header";
import { Panel } from "@/components/ui/panel";
import { AcknowledgeButton } from "./acknowledge-button";
import { manilaDateTime } from "@/lib/dates/manila";
import {
  ariaSortFor,
  buildListHref,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
  type SortSpec,
} from "@/lib/ui/table-params";
import { SortableTh, PlainTh } from "@/components/staff/sortable-th";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";

export const metadata = {
  title: "Critical alerts — staff",
};

const BASE_PATH = "/staff/critical-alerts";

// This section's default has always shown the newest 50 acknowledgements —
// keep that as the page-size default so existing habits (and the "last 50"
// muscle memory) don't change just because the cap is no longer silent.
const PAGE_SIZE_DEFAULT = 50;

/**
 * Sortable columns for the "Recently acknowledged" table ONLY — see the
 * component body for why the unacknowledged worklist above it stays a fixed,
 * unsorted `created_at desc` list instead of sharing this control. Reaches a
 * PostgREST `.order()`, so this allow-list is a security boundary, same as
 * every other sortable staff list (table-params.ts).
 */
const SORTABLE_COLUMNS = [
  "created_at",
  "parameter_name",
  "patient_drm_id",
  "acknowledged_at",
] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

const DEFAULT_SORT: SortSpec<SortColumn> = { key: "acknowledged_at", dir: "desc" };

type AlertRow = {
  id: string;
  created_at: string;
  parameter_name: string;
  direction: string;
  observed_value_si: number | null;
  threshold_si: number | null;
  test_request_id: string;
  patient_drm_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  patients: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
};

function patientName(row: AlertRow): string {
  const p = Array.isArray(row.patients) ? row.patients[0] : row.patients;
  return p ? `${p.last_name}, ${p.first_name}` : "—";
}

function DirectionBadge({ direction }: { direction: string }) {
  const high = direction === "high";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${
        high ? "bg-red-100 text-red-900" : "bg-sky-100 text-sky-900"
      }`}
    >
      {high ? "↑ High" : "↓ Low"}
    </span>
  );
}

interface SearchProps {
  searchParams: Promise<{
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}

export default async function CriticalAlertsPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();

  if (session.role !== "pathologist" && session.role !== "admin") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Critical alerts
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
          This page is for pathologists and admins — critical-value follow-up
          is a clinical responsibility.
        </p>
      </div>
    );
  }

  const params = await searchParams;
  const sort = parseSort(params.sort, params.dir, SORTABLE_COLUMNS, DEFAULT_SORT);
  const size = parsePageSize(params.size, PAGE_SIZE_DEFAULT);
  const page = parsePage(params.page);
  const [from, to] = rangeFor(page, size);

  const supabase = await createClient();

  const alertSelect = `
    id, created_at, parameter_name, direction, observed_value_si,
    threshold_si, test_request_id, patient_drm_id, acknowledged_at,
    acknowledged_by,
    patients ( first_name, last_name )
  `;

  // The unacknowledged worklist is deliberately NOT paginated: it's the "is
  // anything still pending?" view, and a pending critical result must never
  // be able to hide on a page 2 nobody clicks to. It's expected to stay
  // small in practice (each row needs a phone call to close out) — if it
  // ever isn't, the fix is closing alerts faster, not paging the worklist.
  const [{ data: unackedRaw }, { data: recentRaw, count }] = await Promise.all([
    supabase
      .from("critical_alerts")
      .select(alertSelect)
      .is("acknowledged_at", null)
      .order("created_at", { ascending: false })
      // Tie-break on id — with no `.range()` here this can't drop/repeat
      // rows, but it keeps the order deterministic across reloads.
      .order("id", { ascending: true }),
    supabase
      .from("critical_alerts")
      .select(alertSelect, { count: "exact" })
      .not("acknowledged_at", "is", null)
      .order(sort.key, { ascending: sort.dir === "asc" })
      // Tie-break on id — without a total order, `.range()` below can
      // silently drop or repeat rows between pages.
      .order("id", { ascending: true })
      .range(from, to),
  ]);

  const unacked = (unackedRaw ?? []) as AlertRow[];
  const recent = (recentRaw ?? []) as AlertRow[];
  const recentTotal = count ?? 0;
  const recentTotalPages = pageCount(recentTotal, size);

  // Resolve acknowledger names for the recent list.
  const ackerIds = Array.from(
    new Set(
      recent.map((r) => r.acknowledged_by).filter((v): v is string => !!v),
    ),
  );
  const ackerNames = new Map<string, string>();
  if (ackerIds.length > 0) {
    const { data: profs } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", ackerIds);
    for (const p of profs ?? []) ackerNames.set(p.id, p.full_name);
  }

  // Params at their default are omitted so the plain sort state stays the
  // bare /staff/critical-alerts URL. Only the acknowledged-history table
  // below is sortable/paginated — see the SORTABLE_COLUMNS comment for why
  // the unacknowledged worklist above it isn't.
  const isDefaultSort = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  const baseParams: Record<string, string | null> = {
    sort: isDefaultSort ? null : sort.key,
    dir: isDefaultSort ? null : sort.dir,
    size: size === PAGE_SIZE_DEFAULT ? null : String(size),
  };

  // Any change to sort or page size resets to page 1 — same reasoning as
  // every other list page here.
  const href = (overrides: Record<string, string | null> = {}) =>
    buildListHref(BASE_PATH, baseParams, { page: null, ...overrides });

  const sortHref = (key: SortColumn) => {
    const next = nextSort(sort, key);
    const nextIsDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
    return href({ sort: nextIsDefault ? null : next.key, dir: nextIsDefault ? null : next.dir });
  };

  const th = (key: SortColumn, label: string) => (
    <SortableTh key={key} label={label} href={sortHref(key)} state={ariaSortFor(sort, key)} />
  );

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Critical alerts"
        subtitle="Results that crossed a critical threshold. Acknowledge each after the clinical follow-up call — acknowledgement is audit-logged."
      />

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {/* Fixed order (newest first) — this worklist is not
                  user-sortable, see the SORTABLE_COLUMNS comment above. */}
              <PlainTh label="When" />
              <PlainTh label="Patient" />
              <PlainTh label="Parameter" />
              <PlainTh label="Observed vs threshold" />
              <PlainTh label="Test" />
              <PlainTh label="Action" align="right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {unacked.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No unacknowledged critical alerts. 🎉
                </td>
              </tr>
            ) : (
              unacked.map((a) => (
                <tr key={a.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {manilaDateTime(a.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {patientName(a)}
                    </p>
                    <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {a.patient_drm_id ?? "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-[color:var(--color-brand-navy)]">
                      {a.parameter_name}
                    </p>
                    <DirectionBadge direction={a.direction} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                    {a.observed_value_si ?? "?"} (threshold{" "}
                    {a.threshold_si ?? "?"})
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/staff/queue/${a.test_request_id}`}
                      className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Open test →
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AcknowledgeButton alertId={a.id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {/* Exact total, not the old silent "last 50" — that cap hid older
            acknowledged alerts with no indication they existed, which
            matters for values this clinically sensitive. The full history
            is now reachable via the pager below. */}
        <summary className="cursor-pointer px-5 py-4 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Recently acknowledged ({recentTotal})
        </summary>
        <div className="overflow-x-auto border-t border-[color:var(--color-brand-bg-mid)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                {th("created_at", "When")}
                {th("patient_drm_id", "Patient")}
                {th("parameter_name", "Parameter")}
                <PlainTh label="Observed vs threshold" />
                {th("acknowledged_at", "Acknowledged")}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {recent.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    Nothing acknowledged yet.
                  </td>
                </tr>
              ) : (
                recent.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      {manilaDateTime(a.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {patientName(a)}
                      </p>
                      <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                        {a.patient_drm_id ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {a.parameter_name}
                      </p>
                      <DirectionBadge direction={a.direction} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                      {a.observed_value_si ?? "?"} (threshold{" "}
                      {a.threshold_si ?? "?"})
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {a.acknowledged_at ? manilaDateTime(a.acknowledged_at) : "—"}
                      <span className="block text-[color:var(--color-brand-text-soft)]">
                        by{" "}
                        {a.acknowledged_by
                          ? (ackerNames.get(a.acknowledged_by) ?? "—")
                          : "—"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <ListPagination
            page={page}
            pageCount={recentTotalPages}
            total={recentTotal}
            size={size}
            prevHref={
              page > 1
                ? buildListHref(BASE_PATH, baseParams, {
                    page: page - 1 > 1 ? String(page - 1) : null,
                  })
                : null
            }
            nextHref={
              page < recentTotalPages
                ? buildListHref(BASE_PATH, baseParams, { page: String(page + 1) })
                : null
            }
            sizeOptions={PAGE_SIZES.map((s) => ({
              size: s,
              href: href({ size: s === PAGE_SIZE_DEFAULT ? null : String(s) }),
            }))}
            noun="acknowledged alert"
          />
        </div>
      </details>
    </div>
  );
}
