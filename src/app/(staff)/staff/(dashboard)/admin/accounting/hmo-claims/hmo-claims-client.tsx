"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import type { Database } from "@/types/database";
import { snapshotHmoAgingAction, recordHmoExportAuditAction } from "./actions";
import { csvDocumentFromRecords } from "@/lib/csv/escape";
import { REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import type { HmoExportReportKey } from "@/lib/reports/export-audit";
import {
  MarkHistoricBilledModal,
  MarkHistoricPaidModal,
  WriteOffHistoricModal,
  type StaffPick,
  type PaymentMethod,
} from "./_components/historic-claim-modals";
import { Panel } from "@/components/ui/panel";
import { ExportCsvButton } from "@/components/staff/export-csv-link";
import { manilaDate, manilaISODate, todayManilaISODate } from "@/lib/dates/manila";
import {
  ariaSortFor,
  nextSort,
  pageCount,
  type PageSize,
  type SortDir,
  type SortSpec,
} from "@/lib/ui/table-params";
import {
  ClientListPagination,
  ClientSortableTh,
} from "@/components/staff/client-table-controls";
import {
  HMO_UNBILLED_AGE_BAND_LABELS,
  matchesHmoUnbilledAgeBand,
  type HmoUnbilledAgeBand,
} from "@/lib/reports/hmo-unbilled-bands";
import { PlainTh } from "@/components/staff/sortable-th";

type SummaryRow =
  Database["public"]["Views"]["v_hmo_provider_summary"]["Row"];
type UnbilledRow = Database["public"]["Views"]["v_hmo_unbilled"]["Row"];
type StuckRow = Database["public"]["Views"]["v_hmo_stuck"]["Row"];
type AgingRow = Database["public"]["Views"]["v_hmo_ar_aging"]["Row"];

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const BUCKETS = ["0-30", "31-60", "61-90", "91-180", "180+"] as const;

type View = "by_provider" | "all_unbilled" | "all_aging" | "aging_matrix";

const VIEW_LABELS: Record<View, string> = {
  by_provider: "By provider",
  all_unbilled: "All unbilled",
  all_aging: "All aging",
  aging_matrix: "Aging matrix",
};

type Kind = "all" | "lab" | "doctor";

const KIND_LABELS: Record<Kind, string> = {
  all: "All",
  lab: "Lab tests",
  doctor: "Doctor consults",
};

function matchesKind<T extends { kind?: string | null }>(row: T, kind: Kind): boolean {
  if (kind === "all") return true;
  return (row.kind ?? "lab") === kind;
}

// ---------------------------------------------------------------------------
// Sorting for the two detail tables
//
// These sort IN THE BROWSER, over rows the server already walked in full, and
// they page in browser state rather than through the URL — see
// `client-table-controls`. The pure helpers (`nextSort`, `ariaSortFor`,
// `pageCount`) are the same ones the URL-driven list pages use, so a first
// click means the same thing here as it does on Patients or Visits.
// ---------------------------------------------------------------------------

function compareText(a: string, b: string, dir: SortDir): number {
  return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}

function compareNumber(a: number, b: number, dir: SortDir): number {
  return dir === "asc" ? a - b : b - a;
}

/** A view row with a null in the sorted column sinks either way, not to the top on ASC. */
function compareBlankLast(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDir,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareText(a, b, dir);
}

/** `null` amounts and ages read as zero, the same way the cells render them. */
function num(v: number | null | undefined): number {
  return Number(v ?? 0);
}

/**
 * A plain union rather than the `as const` allow-list the URL-driven pages
 * declare. Those need one because `?sort=` is user input that reaches a
 * PostgREST `.order()`; here the key only ever arrives from a typed
 * `onSort` callback on a header this file rendered, and it indexes an
 * in-memory row — there is nothing to validate it against.
 */
type UnbilledSortColumn =
  | "provider_name"
  | "released_at"
  | "kind"
  | "patient_name"
  | "service_description"
  | "days_since_release"
  | "billed_amount_php";

/** Oldest unbilled first — the order the server query already returns. */
const UNBILLED_DEFAULT_SORT: SortSpec<UnbilledSortColumn> = {
  key: "days_since_release",
  dir: "desc",
};

function compareUnbilled(
  a: UnbilledRow,
  b: UnbilledRow,
  sort: SortSpec<UnbilledSortColumn>,
): number {
  let cmp: number;
  switch (sort.key) {
    case "released_at":
      cmp = compareBlankLast(a.released_at, b.released_at, sort.dir);
      break;
    case "days_since_release":
      cmp = compareNumber(num(a.days_since_release), num(b.days_since_release), sort.dir);
      break;
    case "billed_amount_php":
      cmp = compareNumber(num(a.billed_amount_php), num(b.billed_amount_php), sort.dir);
      break;
    default:
      cmp = compareBlankLast(a[sort.key], b[sort.key], sort.dir);
  }
  // The id tie-break is what keeps the page SLICE stable: rows that tie on
  // the visible column would otherwise hold whatever order the view returned
  // and could shift between renders.
  return cmp !== 0 ? cmp : (a.test_request_id ?? "").localeCompare(b.test_request_id ?? "");
}

/** Same shape, same reasoning as `UnbilledSortColumn`. */
type AgingSortColumn =
  | "provider_name"
  | "submitted_at"
  | "kind"
  | "patient_name"
  | "service_description"
  | "days_since_submission"
  | "unresolved_balance_php";

/** Longest-stuck first — the order the server query already returns. */
const AGING_DEFAULT_SORT: SortSpec<AgingSortColumn> = {
  key: "days_since_submission",
  dir: "desc",
};

function compareAging(a: StuckRow, b: StuckRow, sort: SortSpec<AgingSortColumn>): number {
  let cmp: number;
  switch (sort.key) {
    case "submitted_at":
      cmp = compareBlankLast(a.submitted_at, b.submitted_at, sort.dir);
      break;
    case "days_since_submission":
      cmp = compareNumber(
        num(a.days_since_submission),
        num(b.days_since_submission),
        sort.dir,
      );
      break;
    case "unresolved_balance_php":
      cmp = compareNumber(
        num(a.unresolved_balance_php),
        num(b.unresolved_balance_php),
        sort.dir,
      );
      break;
    default:
      cmp = compareBlankLast(a[sort.key], b[sort.key], sort.dir);
  }
  return cmp !== 0 ? cmp : (a.item_id ?? "").localeCompare(b.item_id ?? "");
}

export function HmoClaimsClient({
  summary,
  unbilled,
  unbilledTruncated,
  stuck,
  stuckTruncated,
  aging,
  staff,
  paymentMethods,
  initialAgeBand,
}: {
  summary: SummaryRow[];
  unbilled: UnbilledRow[];
  /** The 20,000-row export ceiling was reached — these are not all of them. */
  unbilledTruncated: boolean;
  stuck: StuckRow[];
  stuckTruncated: boolean;
  aging: AgingRow[];
  staff: StaffPick[];
  paymentMethods: PaymentMethod[];
  /** From `?age=`, set by the admin dashboard's HMO unbilled card. */
  initialAgeBand: HmoUnbilledAgeBand | null;
}) {
  // An `?age=` link means "show me the unbilled rows in this band", so it
  // opens the All-unbilled tab rather than the provider summary this page
  // otherwise defaults to.
  const [view, setView] = useState<View>(
    initialAgeBand ? "all_unbilled" : "by_provider",
  );
  const [ageBand, setAgeBand] = useState<HmoUnbilledAgeBand | null>(
    initialAgeBand,
  );
  const [kind, setKind] = useState<Kind>("all");

  // The age band narrows the unbilled rows only. The dashboard card and this
  // table share matchesHmoUnbilledAgeBand() so the arithmetic cannot drift
  // between the figure and the list it opens.
  const fUnbilled = useMemo(
    () =>
      unbilled.filter(
        (r) =>
          matchesKind(r, kind) &&
          (ageBand === null || matchesHmoUnbilledAgeBand(r, ageBand)),
      ),
    [unbilled, kind, ageBand],
  );
  const fStuck = useMemo(
    () => stuck.filter((r) => matchesKind(r, kind)),
    [stuck, kind],
  );
  const fAging = useMemo(
    () => aging.filter((r) => matchesKind(r, kind)),
    [aging, kind],
  );

  return (
    <div className="space-y-4">
      <ConsolidatedTotals
        summary={summary}
        unbilled={fUnbilled}
        stuck={fStuck}
        aging={fAging}
        kind={kind}
      />
      <KindToggle kind={kind} onChange={setKind} />
      <ViewToggle view={view} onChange={setView} />
      {view === "by_provider" && (
        <ByProvider
          rows={summary}
          unbilled={fUnbilled}
          stuck={fStuck}
          aging={fAging}
          kind={kind}
        />
      )}
      {view === "all_unbilled" && ageBand !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-brand-text-mid)]">
          <span>
            Showing <b>{HMO_UNBILLED_AGE_BAND_LABELS[ageBand].toLowerCase()}</b>{" "}
            only.
          </span>
          <button
            type="button"
            onClick={() => setAgeBand(null)}
            className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Show every age
          </button>
        </p>
      ) : null}
      {view === "all_unbilled" && (
        <AllUnbilled
          rows={fUnbilled}
          kind={kind}
          truncated={unbilledTruncated}
          staff={staff}
          paymentMethods={paymentMethods}
        />
      )}
      {view === "all_aging" && (
        <AllAging
          rows={fStuck}
          kind={kind}
          truncated={stuckTruncated}
          staff={staff}
          paymentMethods={paymentMethods}
        />
      )}
      {view === "aging_matrix" && <AgingMatrix rows={fAging} />}
    </div>
  );
}

function ConsolidatedTotals({
  summary,
  unbilled,
  stuck,
  aging,
  kind,
}: {
  summary: SummaryRow[];
  unbilled: UnbilledRow[];
  stuck: StuckRow[];
  aging: AgingRow[];
  kind: Kind;
}) {
  const totals = useMemo(() => {
    if (kind === "all") {
      // Use the pre-aggregated server totals (already include live + historic).
      let unresolved = 0;
      let unbilledTotal = 0;
      let stuckTotal = 0;
      let providers = 0;
      let oldestIso: string | null = null;
      for (const r of summary) {
        providers += 1;
        unresolved += Number(r.total_unresolved_ar_php ?? 0);
        unbilledTotal += Number(r.total_unbilled_php ?? 0);
        stuckTotal += Number(r.total_stuck_php ?? 0);
        const o = r.oldest_open_released_at;
        if (o && (!oldestIso || o < oldestIso)) oldestIso = o as string;
      }
      return {
        providers,
        unresolved,
        unbilledTotal,
        unbilledCount: unbilled.length,
        stuckTotal,
        stuckCount: stuck.length,
        oldestIso,
      };
    }
    // Kind-filtered: derive from the kind-filtered detail arrays.
    let unbilledTotal = 0;
    for (const r of unbilled) unbilledTotal += Number(r.billed_amount_php ?? 0);
    let stuckTotal = 0;
    for (const r of stuck) stuckTotal += Number(r.unresolved_balance_php ?? 0);
    let unresolved = 0;
    for (const r of aging) unresolved += Number(r.total_php ?? 0);
    const providerIds = new Set<string>();
    for (const r of unbilled) if (r.provider_id) providerIds.add(r.provider_id as string);
    for (const r of stuck) if (r.provider_id) providerIds.add(r.provider_id as string);
    for (const r of aging) if (r.provider_id) providerIds.add(r.provider_id as string);
    let oldestIso: string | null = null;
    for (const r of unbilled) {
      const o = r.released_at ?? null;
      if (o && (!oldestIso || o < oldestIso)) oldestIso = o as string;
    }
    return {
      providers: providerIds.size,
      unresolved,
      unbilledTotal,
      unbilledCount: unbilled.length,
      stuckTotal,
      stuckCount: stuck.length,
      oldestIso,
    };
  }, [summary, unbilled, stuck, aging, kind]);

  const oldestLabel = totals.oldestIso
    ? manilaDate(totals.oldestIso)
    : "—";
  // eslint-disable-next-line react-hooks/purity -- age reflects the current time; client-only display, stable within a day.
  const nowMs = Date.now();
  const oldestAgeDays = totals.oldestIso
    ? Math.max(0, Math.floor((nowMs - new Date(totals.oldestIso).getTime()) / 86400000))
    : null;

  return (
    <section
      aria-label="Consolidated HMO totals"
      className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-navy)] p-4 text-white shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-lg font-bold">
          All HMOs combined
        </h2>
        <p className="text-xs text-white/70">
          {totals.providers} provider{totals.providers === 1 ? "" : "s"}
          {kind !== "all" ? ` · ${KIND_LABELS[kind].toLowerCase()} only` : null}
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Unresolved AR"
          value={PHP.format(totals.unresolved)}
        />
        <Metric
          label="Unbilled"
          value={PHP.format(totals.unbilledTotal)}
          sub={`${totals.unbilledCount} item${totals.unbilledCount === 1 ? "" : "s"}`}
        />
        <Metric
          label="Aging"
          value={PHP.format(totals.stuckTotal)}
          sub={`${totals.stuckCount} item${totals.stuckCount === 1 ? "" : "s"}`}
          tone={totals.stuckTotal > 0 ? "warn" : undefined}
        />
        <Metric
          label="Oldest open"
          value={oldestLabel}
          sub={oldestAgeDays != null ? `${oldestAgeDays} days ago` : undefined}
        />
      </dl>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-white/60">
        {label}
      </dt>
      <dd
        className={
          "mt-1 font-mono text-base font-semibold tabular-nums " +
          (tone === "warn" ? "text-amber-300" : "text-white")
        }
      >
        {value}
      </dd>
      {sub ? (
        <dd className="mt-0.5 text-[10px] text-white/60">{sub}</dd>
      ) : null}
    </div>
  );
}

function KindToggle({
  kind,
  onChange,
}: {
  kind: Kind;
  onChange: (k: Kind) => void;
}) {
  return (
    <nav
      className="inline-flex rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-1"
      aria-label="Filter by claim kind"
    >
      {(Object.keys(KIND_LABELS) as Kind[]).map((k) => {
        const active = k === kind;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange(k)}
            aria-pressed={active}
            className={
              "min-h-[36px] rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider " +
              (active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]")
            }
          >
            {KIND_LABELS[k]}
          </button>
        );
      })}
    </nav>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  return (
    <nav
      className="flex flex-wrap gap-2"
      aria-label="HMO claims view selector"
    >
      {(Object.keys(VIEW_LABELS) as View[]).map((v) => {
        const active = v === view;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={active}
            className={
              "min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider " +
              (active
                ? "bg-[color:var(--color-brand-navy)] text-white"
                : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]")
            }
          >
            {VIEW_LABELS[v]}
          </button>
        );
      })}
    </nav>
  );
}

function ByProvider({
  rows,
  unbilled,
  stuck,
  aging,
  kind,
}: {
  rows: SummaryRow[];
  unbilled: UnbilledRow[];
  stuck: StuckRow[];
  aging: AgingRow[];
  kind: Kind;
}) {
  // Per-provider aggregates from the already kind-filtered arrays.
  const perProvider = useMemo(() => {
    type Agg = { unbilledCount: number; unbilledTotal: number; stuckCount: number; stuckTotal: number; unresolved: number };
    const m = new Map<string, Agg>();
    const ensure = (id: string): Agg => {
      let a = m.get(id);
      if (!a) {
        a = { unbilledCount: 0, unbilledTotal: 0, stuckCount: 0, stuckTotal: 0, unresolved: 0 };
        m.set(id, a);
      }
      return a;
    };
    for (const r of unbilled) {
      if (!r.provider_id) continue;
      const a = ensure(r.provider_id);
      a.unbilledCount += 1;
      a.unbilledTotal += Number(r.billed_amount_php ?? 0);
    }
    for (const r of stuck) {
      if (!r.provider_id) continue;
      const a = ensure(r.provider_id);
      a.stuckCount += 1;
      a.stuckTotal += Number(r.unresolved_balance_php ?? 0);
    }
    for (const r of aging) {
      if (!r.provider_id) continue;
      const a = ensure(r.provider_id);
      a.unresolved += Number(r.total_php ?? 0);
    }
    return m;
  }, [unbilled, stuck, aging]);

  if (rows.length === 0) {
    return (
      <EmptyState message="No active HMO providers." />
    );
  }

  // When kind=all, the server has already ordered by total_unresolved_ar_php
  // DESC. When kind is filtered, sort client-side by the filtered total.
  const sorted =
    kind === "all"
      ? rows
      : [...rows].sort((a, b) => {
          const aT = a.provider_id ? (perProvider.get(a.provider_id)?.unresolved ?? 0) : 0;
          const bT = b.provider_id ? (perProvider.get(b.provider_id)?.unresolved ?? 0) : 0;
          // Providers tie on the total routinely — two on zero is the common
          // case — so break by name, or the cards reshuffle between renders.
          return bT !== aT
            ? bT - aT
            : (a.provider_name ?? "").localeCompare(b.provider_name ?? "");
        });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {sorted.map((r) => {
        const agg = r.provider_id ? perProvider.get(r.provider_id) : undefined;
        return (
          <ProviderCard
            key={r.provider_id ?? r.provider_name ?? "row"}
            row={r}
            kind={kind}
            unbilledCount={agg?.unbilledCount ?? 0}
            unbilledTotal={agg?.unbilledTotal ?? 0}
            stuckCount={agg?.stuckCount ?? 0}
            stuckTotal={agg?.stuckTotal ?? 0}
            unresolvedFiltered={agg?.unresolved ?? 0}
          />
        );
      })}
    </div>
  );
}

function ProviderCard({
  row,
  kind,
  unbilledCount,
  unbilledTotal,
  stuckCount,
  stuckTotal,
  unresolvedFiltered,
}: {
  row: SummaryRow;
  kind: Kind;
  unbilledCount: number;
  unbilledTotal: number;
  stuckCount: number;
  stuckTotal: number;
  unresolvedFiltered: number;
}) {
  const href = row.provider_id
    ? `/staff/admin/accounting/hmo-claims/${row.provider_id}`
    : "#";
  // When kind = "all", show the view's pre-aggregated totals (which already
  // include live + historic). Otherwise show the client-side filtered totals.
  const unresolved = kind === "all" ? (row.total_unresolved_ar_php ?? 0) : unresolvedFiltered;
  const unbilled = kind === "all" ? (row.total_unbilled_php ?? 0) : unbilledTotal;
  const stuck = kind === "all" ? (row.total_stuck_php ?? 0) : stuckTotal;
  const oldest = row.oldest_open_released_at
    ? manilaDate(row.oldest_open_released_at)
    : "—";

  const unbilledLabel =
    unbilledCount > 0
      ? `${unbilledCount} item${unbilledCount === 1 ? "" : "s"} · ${PHP.format(unbilled)}`
      : "—";
  const stuckLabel =
    stuckCount > 0
      ? `${stuckCount} item${stuckCount === 1 ? "" : "s"} · ${PHP.format(stuck)}`
      : "—";

  return (
    <Link
      href={href}
      className="block rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-sm transition hover:border-[color:var(--color-brand-cyan)] hover:shadow"
    >
      <h3 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
        {row.provider_name ?? "Unknown provider"}
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <dt className="text-[color:var(--color-brand-text-soft)]">
          Unresolved AR
        </dt>
        <dd className="text-right font-semibold text-[color:var(--color-brand-navy)]">
          {PHP.format(unresolved)}
        </dd>
        <dt className="text-[color:var(--color-brand-text-soft)]">Unbilled</dt>
        <dd className="text-right font-semibold text-[color:var(--color-brand-navy)]">
          {unbilledLabel}
        </dd>
        <dt className="text-[color:var(--color-brand-text-soft)]">Aging</dt>
        <dd
          className={
            "text-right font-semibold " +
            (stuckCount > 0
              ? "text-red-600"
              : "text-[color:var(--color-brand-navy)]")
          }
        >
          {stuckLabel}
        </dd>
        <dt className="text-[color:var(--color-brand-text-soft)]">
          Oldest open
        </dt>
        <dd className="text-right text-[color:var(--color-brand-navy)]">
          {oldest}
        </dd>
      </dl>
    </Link>
  );
}

/**
 * Rows per page before the picker changes it. 100 is what both tables have
 * always shown; unlike the URL-driven pages there is no `?size=` to remember
 * it across a reload, because paging here never leaves the page.
 */
const TOP_PAGE_SIZE: PageSize = 100;

/**
 * Everything one of these tables needs to sort and page itself.
 *
 * Both tables hold identical state, and both had the same defect: the `kind`
 * toggle lives in the PARENT, so switching it shrank `rows` without resetting
 * `page` — leaving the reader on, say, page 5 of a set that now has one page,
 * looking at an empty table with the pager hidden (it only rendered when
 * there was more than one page) and no way back. Clamping the page against
 * the current page count fixes that wherever the row set changes, not just on
 * the two state changes that remembered to reset it.
 */
function useTableState<K extends string>(defaultSort: SortSpec<K>) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortSpec<K>>(defaultSort);
  const [size, setSize] = useState<number>(TOP_PAGE_SIZE);
  // 1-based, like the rest of the list contract.
  const [page, setPage] = useState(1);

  return {
    filter,
    sort,
    size,
    page,
    onFilter(next: string) {
      setFilter(next);
      setPage(1);
    },
    onSort(key: K) {
      setSort((current) => nextSort(current, key));
      // A re-sort goes back to page 1 — page 5 of a set that just reordered
      // is a screenful of unrelated rows.
      setPage(1);
    },
    onSize(next: number) {
      setSize(next);
      setPage(1);
    },
    setPage,
  };
}

/** Returns whether a file was actually produced — an empty set discloses nothing. */
function exportRowsCsv(
  rows: Record<string, unknown>[],
  filename: string,
  truncated: boolean,
): boolean {
  if (rows.length === 0) return false;
  // The house builder + escaper, not a hand-rolled copy of either. The notice
  // is the same one reportCsvResponse writes in-band: a silently short export
  // reads as "that's everything", and the reader of the file is not
  // necessarily the person who clicked.
  const text = csvDocumentFromRecords(rows, {
    truncatedNotice: truncated
      ? `TRUNCATED — more rows matched than the ${REPORT_EXPORT_MAX_ROWS} exported. Narrow the filters.`
      : undefined,
  });
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Download a browser-built CSV and leave an audit row behind it.
 *
 * RA 10173: every export that discloses patient data is attributable. These
 * two build the file client-side from the rows already on screen, so there is
 * no Route Handler for reportCsvResponse to audit from — the row comes from a
 * Server Action instead.
 *
 * The file goes FIRST and stays synchronous with the click. WebKit ties
 * permission to fire an `<a download>` to the user activation that started it,
 * and an awaited round-trip in between can quietly consume that activation —
 * the admin would see the button flicker and get no file, with nothing to
 * explain it. Auditing afterwards costs nothing that auditing first bought:
 * audit() logs and swallows a failed insert rather than withholding a file the
 * admin is entitled to, so the order never gated the disclosure either way.
 *
 * A filtered-to-empty set produces no file, so it writes no row — an export
 * audit that fires when nothing was exported is worse than none.
 */
function useAuditedCsvExport(report: HmoExportReportKey) {
  const [pending, startTransition] = useTransition();

  function download(args: {
    rows: Record<string, unknown>[];
    filename: string;
    kind: Kind;
    search: string;
    truncated: boolean;
  }) {
    // Belt and braces — the control is already disabled on an empty set, so
    // this only fires if a future call site forgets that guard.
    if (!exportRowsCsv(args.rows, args.filename, args.truncated)) return;
    startTransition(async () => {
      try {
        await recordHmoExportAuditAction({
          report,
          rows_exported: args.rows.length,
          truncated: args.truncated,
          kind: args.kind,
          search: args.search,
        });
      } catch (thrown) {
        // requireAdminStaff() sends an expired or downgraded session to the
        // login screen, and redirect() works by THROWING — a bare catch here
        // would eat the navigation and strand the admin on a page they are no
        // longer allowed to be on. unstable_rethrow re-raises Next's own
        // control flow and returns for everything else, which really is
        // nothing to undo: the file is already downloaded.
        unstable_rethrow(thrown);
      }
    });
  }

  return { pending, download };
}

function AllUnbilled({
  rows,
  kind,
  truncated,
  staff,
  paymentMethods,
}: {
  rows: UnbilledRow[];
  kind: Kind;
  truncated: boolean;
  staff: StaffPick[];
  paymentMethods: PaymentMethod[];
}) {
  const csv = useAuditedCsvExport("hmo_unbilled");
  const table = useTableState<UnbilledSortColumn>(UNBILLED_DEFAULT_SORT);
  const { filter, sort, size } = table;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkModal, setBulkModal] = useState<null | "billed" | "paid" | "writeoff">(null);
  const [rowModal, setRowModal] = useState<null | {
    kind: "billed" | "paid" | "writeoff";
    claimId: string;
    amount: number;
  }>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.provider_name ?? "").toLowerCase().includes(q) ||
        (r.patient_name ?? "").toLowerCase().includes(q) ||
        (r.service_description ?? "").toLowerCase().includes(q),
    );
  }, [rows, filter]);
  const ordered = useMemo(
    () => [...filtered].sort((a, b) => compareUnbilled(a, b, sort)),
    [filtered, sort],
  );
  const totalPages = pageCount(ordered.length, size);
  // Clamped, not trusted: the parent's kind toggle can shrink the set under a
  // page the reader is already on.
  const page = Math.min(table.page, totalPages);
  const pageRows = ordered.slice((page - 1) * size, page * size);
  const today = todayManilaISODate();

  const th = (key: UnbilledSortColumn, label: string, align?: "left" | "right") => (
    <ClientSortableTh
      key={key}
      label={label}
      onSort={() => table.onSort(key)}
      state={ariaSortFor(sort, key)}
      align={align}
    />
  );

  const historicIdsOnPage = useMemo(
    () =>
      pageRows
        .filter((r) => r.is_historic && r.test_request_id)
        .map((r) => r.test_request_id as string),
    [pageRows],
  );
  const selectedHistoricTotal = useMemo(() => {
    let t = 0;
    for (const r of rows) {
      if (r.is_historic && r.test_request_id && selected.has(r.test_request_id)) {
        t += Number(r.billed_amount_php ?? 0);
      }
    }
    return t;
  }, [rows, selected]);
  const selectedHistoricIds = Array.from(selected);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllOnPage() {
    setSelected((prev) => {
      const allOn =
        historicIdsOnPage.length > 0 &&
        historicIdsOnPage.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allOn) for (const id of historicIdsOnPage) next.delete(id);
      else for (const id of historicIdsOnPage) next.add(id);
      return next;
    });
  }

  function exportCsv() {
    csv.download({
      rows: filtered.map((r) => ({
        provider: r.provider_name ?? "",
        is_historic: r.is_historic ? "yes" : "no",
        kind: r.kind ?? "lab",
        released_at: manilaISODate(r.released_at) ?? "",
        days_since_release: r.days_since_release ?? "",
        patient: r.patient_name ?? "",
        service: r.service_description ?? "",
        amount_php: r.billed_amount_php ?? 0,
      })),
      filename: `hmo-all-unbilled-${today}.csv`,
      kind,
      search: filter.trim(),
      truncated,
    });
  }

  if (rows.length === 0) {
    return <EmptyState message="Nothing unbilled." />;
  }

  const allOnPageSelected =
    historicIdsOnPage.length > 0 &&
    historicIdsOnPage.every((id) => selected.has(id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by provider / patient / service..."
          value={filter}
          onChange={(e) => table.onFilter(e.target.value)}
          className="min-w-[260px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
        <ExportCsvButton
          onClick={exportCsv}
          disabled={csv.pending || filtered.length === 0}
        />
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"} · Total{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {PHP.format(filtered.reduce((s, r) => s + Number(r.billed_amount_php ?? 0), 0))}
          </span>
        </div>
        {truncated && (
          <p className="w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows —
            more matched, so this list, its total and its export are all
            incomplete — and so is what the filter box can find, since it only
            searches rows that were loaded. Open a provider from “By provider”
            to see all of theirs.
          </p>
        )}
      </div>
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">
                <label className="inline-flex min-h-[44px] items-center" title="Select all historic rows on this page">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={historicIdsOnPage.length === 0}
                    aria-label="Select all historic unbilled rows on this page"
                    className="h-4 w-4"
                  />
                </label>
              </th>
              {th("provider_name", "Provider")}
              {th("released_at", "Released")}
              {th("kind", "Kind")}
              {th("patient_name", "Patient")}
              {th("service_description", "Service")}
              {th("days_since_release", "Age", "right")}
              {th("billed_amount_php", "Amount", "right")}
              <PlainTh label="Actions" align="right" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              const id = r.test_request_id as string | null;
              const isHistoric = Boolean(r.is_historic);
              const isSelected = id ? selected.has(id) : false;
              return (
                <tr
                  key={id ?? `${r.visit_id}-${r.released_at}`}
                  className={
                    "border-t border-[color:var(--color-brand-bg-mid)] " +
                    (r.past_threshold ? "bg-amber-50" : "")
                  }
                >
                  <td className="px-4 py-3">
                    <label className="inline-flex min-h-[44px] items-center">
                      <input
                        type="checkbox"
                        disabled={!isHistoric || !id}
                        checked={isSelected}
                        onChange={() => id && isHistoric && toggle(id)}
                        aria-label={`Select ${r.patient_name ?? id ?? ""}`}
                        title={!isHistoric ? "Live rows resolve via provider drilldown" : undefined}
                        className="h-4 w-4"
                      />
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    {r.provider_name ?? "—"}
                    {isHistoric && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                        Historic
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.released_at
                      ? manilaDate(r.released_at)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
                        (r.kind === "doctor" ? "bg-indigo-100 text-indigo-800" : "bg-sky-100 text-sky-800")
                      }
                    >
                      {r.kind ?? "lab"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {isHistoric && id && r.provider_id ? (
                      <Link href={`/staff/admin/accounting/hmo-claims/${r.provider_id}/historic/${id}`} className="text-[color:var(--color-brand-cyan)] hover:underline">
                        {r.patient_name ?? "(unknown)"}
                      </Link>
                    ) : (
                      r.patient_name ?? "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.service_description ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {r.days_since_release ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {PHP.format(r.billed_amount_php ?? 0)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isHistoric && id ? (
                      <div className="flex flex-nowrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setRowModal({ kind: "billed", claimId: id, amount: Number(r.billed_amount_php ?? 0) })}
                          className="min-h-[28px] whitespace-nowrap rounded-md bg-[color:var(--color-brand-navy)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
                        >
                          Mark billed
                        </button>
                        <button
                          type="button"
                          onClick={() => setRowModal({ kind: "paid", claimId: id, amount: Number(r.billed_amount_php ?? 0) })}
                          className="min-h-[28px] whitespace-nowrap rounded-md border border-emerald-600 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 hover:bg-emerald-600 hover:text-white"
                        >
                          Mark paid
                        </button>
                        <button
                          type="button"
                          onClick={() => setRowModal({ kind: "writeoff", claimId: id, amount: Number(r.billed_amount_php ?? 0) })}
                          className="min-h-[28px] whitespace-nowrap rounded-md border border-red-600 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700 hover:bg-red-600 hover:text-white"
                        >
                          Write off
                        </button>
                      </div>
                    ) : r.provider_id ? (
                      <Link
                        href={`/staff/admin/accounting/hmo-claims/${r.provider_id}`}
                        className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      {selected.size > 0 && (
        <Panel className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 p-3 shadow-sm">
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {selected.size}
            </span>{" "}
            historic claims selected · total{" "}
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {PHP.format(selectedHistoricTotal)}
            </span>
          </div>
          <div className="flex flex-nowrap items-center gap-2">
            <button
              type="button"
              onClick={() => setBulkModal("billed")}
              className="min-h-[44px] whitespace-nowrap rounded-md bg-[color:var(--color-brand-navy)] px-3 py-2 text-xs font-bold uppercase tracking-wider text-white"
            >
              Mark billed ({selected.size})
            </button>
            <button
              type="button"
              onClick={() => setBulkModal("paid")}
              className="min-h-[44px] whitespace-nowrap rounded-md border border-emerald-600 bg-white px-3 py-2 text-xs font-bold uppercase tracking-wider text-emerald-700 hover:bg-emerald-600 hover:text-white"
            >
              Mark paid
            </button>
            <button
              type="button"
              onClick={() => setBulkModal("writeoff")}
              className="min-h-[44px] whitespace-nowrap rounded-md border border-red-600 bg-white px-3 py-2 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-600 hover:text-white"
            >
              Write off
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="min-h-[44px] whitespace-nowrap rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-semibold text-[color:var(--color-brand-text-soft)]"
            >
              Clear
            </button>
          </div>
        </Panel>
      )}
      <ClientListPagination
        page={page}
        pageCount={totalPages}
        total={ordered.length}
        size={size}
        onPage={table.setPage}
        onSize={table.onSize}
        noun="row"
      />
      {bulkModal === "billed" && (
        <MarkHistoricBilledModal
          claimIds={selectedHistoricIds}
          totalAmount={selectedHistoricTotal}
          staff={staff}
          onClose={() => { setBulkModal(null); setSelected(new Set()); }}
        />
      )}
      {bulkModal === "paid" && (
        <MarkHistoricPaidModal
          claimIds={selectedHistoricIds}
          totalAmount={selectedHistoricTotal}
          staff={staff}
          paymentMethods={paymentMethods}
          onClose={() => { setBulkModal(null); setSelected(new Set()); }}
        />
      )}
      {bulkModal === "writeoff" && (
        <WriteOffHistoricModal
          claimIds={selectedHistoricIds}
          totalAmount={selectedHistoricTotal}
          staff={staff}
          onClose={() => { setBulkModal(null); setSelected(new Set()); }}
        />
      )}
      {rowModal?.kind === "billed" && (
        <MarkHistoricBilledModal
          claimIds={[rowModal.claimId]}
          totalAmount={rowModal.amount}
          staff={staff}
          onClose={() => setRowModal(null)}
        />
      )}
      {rowModal?.kind === "paid" && (
        <MarkHistoricPaidModal
          claimIds={[rowModal.claimId]}
          totalAmount={rowModal.amount}
          staff={staff}
          paymentMethods={paymentMethods}
          onClose={() => setRowModal(null)}
        />
      )}
      {rowModal?.kind === "writeoff" && (
        <WriteOffHistoricModal
          claimIds={[rowModal.claimId]}
          totalAmount={rowModal.amount}
          staff={staff}
          onClose={() => setRowModal(null)}
        />
      )}
    </div>
  );
}

function AllAging({
  rows,
  kind,
  truncated,
  staff,
  paymentMethods,
}: {
  rows: StuckRow[];
  kind: Kind;
  truncated: boolean;
  staff: StaffPick[];
  paymentMethods: PaymentMethod[];
}) {
  // "All aging" is the v_hmo_stuck detail — submitted claims still unresolved.
  // v_hmo_ar_aging feeds the separate matrix view.
  const csv = useAuditedCsvExport("hmo_aging");
  const table = useTableState<AgingSortColumn>(AGING_DEFAULT_SORT);
  const { filter, sort, size } = table;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkModal, setBulkModal] = useState<null | "paid" | "writeoff">(null);
  const [rowModal, setRowModal] = useState<null | {
    kind: "paid" | "writeoff";
    claimId: string;
    amount: number;
  }>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.provider_name ?? "").toLowerCase().includes(q) ||
        (r.patient_name ?? "").toLowerCase().includes(q) ||
        (r.service_description ?? "").toLowerCase().includes(q),
    );
  }, [rows, filter]);
  const ordered = useMemo(
    () => [...filtered].sort((a, b) => compareAging(a, b, sort)),
    [filtered, sort],
  );
  const totalPages = pageCount(ordered.length, size);
  // Clamped — see AllUnbilled.
  const page = Math.min(table.page, totalPages);
  const pageRows = ordered.slice((page - 1) * size, page * size);
  const today = todayManilaISODate();

  const th = (key: AgingSortColumn, label: string, align?: "left" | "right") => (
    <ClientSortableTh
      key={key}
      label={label}
      onSort={() => table.onSort(key)}
      state={ariaSortFor(sort, key)}
      align={align}
    />
  );

  // For bulk-select: only historic rows can be acted on in bulk (live rows
  // resolve via their batch).
  const historicIdsOnPage = useMemo(
    () =>
      pageRows
        .filter((r) => r.is_historic && r.item_id)
        .map((r) => r.item_id as string),
    [pageRows],
  );
  const selectedHistoricTotal = useMemo(() => {
    let t = 0;
    for (const r of rows) {
      if (r.is_historic && r.item_id && selected.has(r.item_id)) {
        t += Number(r.unresolved_balance_php ?? 0);
      }
    }
    return t;
  }, [rows, selected]);
  const selectedHistoricIds = Array.from(selected);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const allOnPageSelected =
        historicIdsOnPage.length > 0 &&
        historicIdsOnPage.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const id of historicIdsOnPage) next.delete(id);
      } else {
        for (const id of historicIdsOnPage) next.add(id);
      }
      return next;
    });
  }

  function exportCsv() {
    csv.download({
      rows: filtered.map((r) => ({
        provider: r.provider_name ?? "",
        is_historic: r.is_historic ? "yes" : "no",
        kind: r.kind ?? "lab",
        submitted_at: r.submitted_at ? String(r.submitted_at).slice(0, 10) : "",
        days_late: r.days_since_submission ?? "",
        patient: r.patient_name ?? "",
        service: r.service_description ?? "",
        unresolved_php: r.unresolved_balance_php ?? 0,
      })),
      filename: `hmo-all-aging-${today}.csv`,
      kind,
      search: filter.trim(),
      truncated,
    });
  }

  if (rows.length === 0) {
    return <EmptyState message="Nothing aging." />;
  }

  const allOnPageSelected =
    historicIdsOnPage.length > 0 &&
    historicIdsOnPage.every((id) => selected.has(id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by provider / patient / service..."
          value={filter}
          onChange={(e) => table.onFilter(e.target.value)}
          className="min-w-[260px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
        <ExportCsvButton
          onClick={exportCsv}
          disabled={csv.pending || filtered.length === 0}
        />
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"} · Total{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {PHP.format(filtered.reduce((s, r) => s + Number(r.unresolved_balance_php ?? 0), 0))}
          </span>
        </div>
        {truncated && (
          <p className="w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString()} rows —
            more matched, so this list, its total and its export are all
            incomplete — and so is what the filter box can find, since it only
            searches rows that were loaded. Open a provider from “By provider”
            to see all of theirs.
          </p>
        )}
      </div>
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">
                <label className="inline-flex min-h-[44px] items-center" title="Select all historic rows on this page">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={historicIdsOnPage.length === 0}
                    aria-label="Select all historic aging rows on this page"
                    className="h-4 w-4"
                  />
                </label>
              </th>
              {th("provider_name", "Provider")}
              {th("submitted_at", "Submitted")}
              {th("kind", "Kind")}
              {th("patient_name", "Patient")}
              {th("service_description", "Service")}
              {th("days_since_submission", "Days late", "right")}
              {th("unresolved_balance_php", "Unresolved", "right")}
              <PlainTh label="Actions" align="right" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              const id = r.item_id as string | null;
              const isHistoric = Boolean(r.is_historic);
              const isSelected = id ? selected.has(id) : false;
              return (
                <tr
                  key={id ?? `${r.batch_id}-${r.submitted_at}`}
                  className="border-t border-[color:var(--color-brand-bg-mid)] bg-red-50"
                >
                  <td className="px-4 py-3">
                    <label className="inline-flex min-h-[44px] items-center">
                      <input
                        type="checkbox"
                        disabled={!isHistoric || !id}
                        checked={isSelected}
                        onChange={() => id && isHistoric && toggle(id)}
                        aria-label={`Select ${r.patient_name ?? id ?? ""}`}
                        title={!isHistoric ? "Live rows resolve via their batch" : undefined}
                        className="h-4 w-4"
                      />
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    {r.provider_name ?? "—"}
                    {isHistoric && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                        Historic
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.submitted_at
                      ? manilaDate(r.submitted_at)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
                        (r.kind === "doctor" ? "bg-indigo-100 text-indigo-800" : "bg-sky-100 text-sky-800")
                      }
                    >
                      {r.kind ?? "lab"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {isHistoric && id && r.provider_id ? (
                      <Link href={`/staff/admin/accounting/hmo-claims/${r.provider_id}/historic/${id}`} className="text-[color:var(--color-brand-cyan)] hover:underline">
                        {r.patient_name ?? "(unknown)"}
                      </Link>
                    ) : (
                      r.patient_name ?? "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.service_description ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-red-700">
                    {r.days_since_submission ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {PHP.format(r.unresolved_balance_php ?? 0)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isHistoric && id ? (
                      <div className="flex flex-nowrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setRowModal({ kind: "paid", claimId: id, amount: Number(r.unresolved_balance_php ?? 0) })}
                          className="min-h-[28px] whitespace-nowrap rounded-md border border-emerald-600 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 hover:bg-emerald-600 hover:text-white"
                        >
                          Mark paid
                        </button>
                        <button
                          type="button"
                          onClick={() => setRowModal({ kind: "writeoff", claimId: id, amount: Number(r.unresolved_balance_php ?? 0) })}
                          className="min-h-[28px] whitespace-nowrap rounded-md border border-red-600 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700 hover:bg-red-600 hover:text-white"
                        >
                          Write off
                        </button>
                      </div>
                    ) : r.batch_id ? (
                      <Link
                        href={`/staff/admin/accounting/hmo-claims/batches/${r.batch_id}`}
                        className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open batch
                      </Link>
                    ) : r.provider_id ? (
                      <Link
                        href={`/staff/admin/accounting/hmo-claims/${r.provider_id}`}
                        className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      {selected.size > 0 && (
        <Panel className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 p-3 shadow-sm">
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {selected.size}
            </span>{" "}
            historic claims selected · total{" "}
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {PHP.format(selectedHistoricTotal)}
            </span>
          </div>
          <div className="flex flex-nowrap items-center gap-2">
            <button
              type="button"
              onClick={() => setBulkModal("paid")}
              className="min-h-[44px] whitespace-nowrap rounded-md border border-emerald-600 bg-white px-3 py-2 text-xs font-bold uppercase tracking-wider text-emerald-700 hover:bg-emerald-600 hover:text-white"
            >
              Mark paid ({selected.size})
            </button>
            <button
              type="button"
              onClick={() => setBulkModal("writeoff")}
              className="min-h-[44px] whitespace-nowrap rounded-md border border-red-600 bg-white px-3 py-2 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-600 hover:text-white"
            >
              Write off
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="min-h-[44px] whitespace-nowrap rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-semibold text-[color:var(--color-brand-text-soft)]"
            >
              Clear
            </button>
          </div>
        </Panel>
      )}
      <ClientListPagination
        page={page}
        pageCount={totalPages}
        total={ordered.length}
        size={size}
        onPage={table.setPage}
        onSize={table.onSize}
        noun="row"
      />
      {bulkModal === "paid" && (
        <MarkHistoricPaidModal
          claimIds={selectedHistoricIds}
          totalAmount={selectedHistoricTotal}
          staff={staff}
          paymentMethods={paymentMethods}
          onClose={() => { setBulkModal(null); setSelected(new Set()); }}
        />
      )}
      {bulkModal === "writeoff" && (
        <WriteOffHistoricModal
          claimIds={selectedHistoricIds}
          totalAmount={selectedHistoricTotal}
          staff={staff}
          onClose={() => { setBulkModal(null); setSelected(new Set()); }}
        />
      )}
      {rowModal?.kind === "paid" && (
        <MarkHistoricPaidModal
          claimIds={[rowModal.claimId]}
          totalAmount={rowModal.amount}
          staff={staff}
          paymentMethods={paymentMethods}
          onClose={() => setRowModal(null)}
        />
      )}
      {rowModal?.kind === "writeoff" && (
        <WriteOffHistoricModal
          claimIds={[rowModal.claimId]}
          totalAmount={rowModal.amount}
          staff={staff}
          onClose={() => setRowModal(null)}
        />
      )}
    </div>
  );
}

function AgingMatrix({ rows }: { rows: AgingRow[] }) {
  const matrix = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const name = r.provider_name ?? "Unknown";
      if (!m.has(name)) m.set(name, {});
      const bucket = r.bucket ?? "";
      const total = r.total_php ?? 0;
      if (BUCKETS.includes(bucket as (typeof BUCKETS)[number])) {
        m.get(name)![bucket] = (m.get(name)![bucket] ?? 0) + total;
      }
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const [pending, startTransition] = useTransition();
  const [snapResult, setSnapResult] = useState<string | null>(null);
  const today = todayManilaISODate();
  const [snapDate, setSnapDate] = useState(today);

  function snapshot() {
    setSnapResult(null);
    startTransition(async () => {
      const res = await snapshotHmoAgingAction({ snapshot_date: snapDate });
      if (!res.ok) { setSnapResult(`Failed: ${res.error}`); return; }
      setSnapResult(`Saved ${res.data?.rows} rows for ${snapDate}.`);
    });
  }

  if (matrix.length === 0) {
    return <EmptyState message="No aging data." />;
  }

  return (
    <>
      <Panel className="mb-3 flex flex-wrap items-center gap-2 p-3 text-xs">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">Snapshot aging as of</span>
        <input
          type="date"
          value={snapDate}
          onChange={(e) => setSnapDate(e.target.value)}
          max={today}
          className="min-h-[36px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2"
        />
        <button
          type="button"
          onClick={snapshot}
          disabled={pending}
          className="min-h-[36px] rounded-md border border-[color:var(--color-brand-navy)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white disabled:opacity-60"
        >
          {pending ? "Saving..." : "Take snapshot"}
        </button>
        <Link href="/staff/admin/accounting/hmo-claims/aging-snapshots" className="text-[color:var(--color-brand-cyan)] hover:underline">
          View past snapshots →
        </Link>
        {snapResult && <span className="text-[color:var(--color-brand-text-soft)]">{snapResult}</span>}
      </Panel>
      {/* Desktop: matrix table */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th scope="col" className="px-4 py-3">
                Provider
              </th>
              {BUCKETS.map((b) => (
                <th key={b} scope="col" className="px-4 py-3 text-right">
                  {b}
                </th>
              ))}
              <th scope="col" className="px-4 py-3 text-right">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.map(([name, buckets]) => {
              const total = BUCKETS.reduce(
                (sum, b) => sum + (buckets[b] ?? 0),
                0,
              );
              return (
                <tr
                  key={name}
                  className="border-t border-[color:var(--color-brand-bg-mid)]"
                >
                  <th
                    scope="row"
                    className="px-4 py-3 text-left font-semibold text-[color:var(--color-brand-navy)]"
                  >
                    {name}
                  </th>
                  {BUCKETS.map((b) => {
                    const v = buckets[b];
                    return (
                      <td
                        key={b}
                        className="px-4 py-3 text-right font-mono text-xs"
                      >
                        {v && v > 0 ? PHP.format(v) : "—"}
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 text-right font-semibold text-[color:var(--color-brand-navy)]">
                    {total > 0 ? PHP.format(total) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {/* Mobile: per-provider accordions */}
      <div className="space-y-2 md:hidden">
        {matrix.map(([name, buckets]) => {
          const total = BUCKETS.reduce(
            (sum, b) => sum + (buckets[b] ?? 0),
            0,
          );
          return (
            <details
              key={name}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white"
            >
              <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-md px-4 py-3 text-sm">
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  {name}
                </span>
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  {total > 0 ? PHP.format(total) : "—"}
                </span>
              </summary>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[color:var(--color-brand-bg-mid)] px-4 py-3 text-xs">
                {BUCKETS.map((b) => {
                  const v = buckets[b] ?? 0;
                  return (
                    <Fragment key={b}>
                      <dt className="font-mono text-[color:var(--color-brand-text-soft)]">
                        {b}
                      </dt>
                      <dd className="text-right font-mono text-[color:var(--color-brand-navy)]">
                        {v > 0 ? PHP.format(v) : "—"}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
            </details>
          );
        })}
      </div>
    </>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
      {message}
    </div>
  );
}
