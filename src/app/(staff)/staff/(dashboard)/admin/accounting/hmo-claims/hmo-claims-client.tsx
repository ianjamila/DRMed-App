"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { Database } from "@/types/database";
import { snapshotHmoAgingAction } from "./actions";

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

type View = "by_provider" | "all_unbilled" | "all_stuck" | "aging_matrix";

const VIEW_LABELS: Record<View, string> = {
  by_provider: "By provider",
  all_unbilled: "All unbilled",
  all_stuck: "All stuck",
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

export function HmoClaimsClient({
  summary,
  unbilled,
  stuck,
  aging,
}: {
  summary: SummaryRow[];
  unbilled: UnbilledRow[];
  stuck: StuckRow[];
  aging: AgingRow[];
}) {
  const [view, setView] = useState<View>("by_provider");
  const [kind, setKind] = useState<Kind>("all");

  const fUnbilled = useMemo(
    () => unbilled.filter((r) => matchesKind(r, kind)),
    [unbilled, kind],
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
      {view === "all_unbilled" && <AllUnbilled rows={fUnbilled} />}
      {view === "all_stuck" && <AllStuck rows={fStuck} />}
      {view === "aging_matrix" && <AgingMatrix rows={fAging} />}
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
          return bT - aT;
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
    ? new Date(row.oldest_open_released_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })
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
      <h3 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
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
        <dt className="text-[color:var(--color-brand-text-soft)]">Stuck</dt>
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

const TOP_PAGE_SIZE = 100;

function exportRowsCsv(rows: Record<string, unknown>[], filename: string) {
  if (rows.length === 0) return;
  const header = Object.keys(rows[0]);
  const lines: string[][] = [header];
  for (const r of rows) {
    lines.push(header.map((h) => String(r[h] ?? "")));
  }
  const text = lines
    .map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function AllUnbilled({ rows }: { rows: UnbilledRow[] }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
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
  const totalPages = Math.max(1, Math.ceil(filtered.length / TOP_PAGE_SIZE));
  const pageRows = filtered.slice(page * TOP_PAGE_SIZE, (page + 1) * TOP_PAGE_SIZE);
  const today = new Date().toISOString().slice(0, 10);

  function exportCsv() {
    exportRowsCsv(
      filtered.map((r) => ({
        provider: r.provider_name ?? "",
        is_historic: r.is_historic ? "yes" : "no",
        kind: r.kind ?? "lab",
        released_at: r.released_at ? new Date(r.released_at).toISOString().slice(0, 10) : "",
        days_since_release: r.days_since_release ?? "",
        patient: r.patient_name ?? "",
        service: r.service_description ?? "",
        amount_php: r.billed_amount_php ?? 0,
      })),
      `hmo-all-unbilled-${today}.csv`,
    );
  }

  if (rows.length === 0) {
    return <EmptyState message="Nothing unbilled." />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by provider / patient / service..."
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(0); }}
          className="min-w-[260px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={exportCsv}
          className="min-h-[36px] rounded-md border border-[color:var(--color-brand-navy)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          Export CSV
        </button>
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"} · Total{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {PHP.format(filtered.reduce((s, r) => s + Number(r.billed_amount_php ?? 0), 0))}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Released</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3 text-right">Age</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr
                key={r.test_request_id ?? `${r.visit_id}-${r.released_at}`}
                className={
                  "border-t border-[color:var(--color-brand-bg-mid)] " +
                  (r.past_threshold ? "bg-amber-50" : "")
                }
              >
                <td className="px-4 py-3">
                  {r.provider_name ?? "—"}
                  {r.is_historic && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                      Historic
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {r.released_at
                    ? new Date(r.released_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })
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
                  {r.is_historic && r.test_request_id && r.provider_id ? (
                    <Link href={`/staff/admin/accounting/hmo-claims/${r.provider_id}/historic/${r.test_request_id}`} className="text-[color:var(--color-brand-cyan)] hover:underline">
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
                  {r.provider_id ? (
                    <Link
                      href={`/staff/admin/accounting/hmo-claims/${r.provider_id}`}
                      className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Open
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-xs">
          <span>Page {page + 1} of {totalPages}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Prev</button>
            <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AllStuck({ rows }: { rows: StuckRow[] }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
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
  const totalPages = Math.max(1, Math.ceil(filtered.length / TOP_PAGE_SIZE));
  const pageRows = filtered.slice(page * TOP_PAGE_SIZE, (page + 1) * TOP_PAGE_SIZE);
  const today = new Date().toISOString().slice(0, 10);

  function exportCsv() {
    exportRowsCsv(
      filtered.map((r) => ({
        provider: r.provider_name ?? "",
        is_historic: r.is_historic ? "yes" : "no",
        kind: r.kind ?? "lab",
        submitted_at: r.submitted_at ? String(r.submitted_at).slice(0, 10) : "",
        days_late: r.days_since_submission ?? "",
        patient: r.patient_name ?? "",
        service: r.service_description ?? "",
        unresolved_php: r.unresolved_balance_php ?? 0,
      })),
      `hmo-all-stuck-${today}.csv`,
    );
  }

  if (rows.length === 0) {
    return <EmptyState message="Nothing stuck." />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Filter by provider / patient / service..."
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(0); }}
          className="min-w-[260px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={exportCsv}
          className="min-h-[36px] rounded-md border border-[color:var(--color-brand-navy)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          Export CSV
        </button>
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"} · Total{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {PHP.format(filtered.reduce((s, r) => s + Number(r.unresolved_balance_php ?? 0), 0))}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Submitted</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3 text-right">Days late</th>
              <th className="px-4 py-3 text-right">Unresolved</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr
                key={r.item_id ?? `${r.batch_id}-${r.submitted_at}`}
                className="border-t border-[color:var(--color-brand-bg-mid)] bg-red-50"
              >
                <td className="px-4 py-3">
                  {r.provider_name ?? "—"}
                  {r.is_historic && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                      Historic
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {r.submitted_at
                    ? new Date(r.submitted_at).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })
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
                  {r.is_historic && r.item_id && r.provider_id ? (
                    <Link href={`/staff/admin/accounting/hmo-claims/${r.provider_id}/historic/${r.item_id}`} className="text-[color:var(--color-brand-cyan)] hover:underline">
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
                  {r.batch_id ? (
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
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-xs">
          <span>Page {page + 1} of {totalPages}</span>
          <div className="flex gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Prev</button>
            <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
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
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
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
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-xs">
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
      </div>
      {/* Desktop: matrix table */}
      <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
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
      </div>

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
