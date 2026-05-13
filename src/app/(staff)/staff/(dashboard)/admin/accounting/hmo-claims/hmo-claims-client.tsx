"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import type { Database } from "@/types/database";

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

  return (
    <div className="space-y-4">
      <ViewToggle view={view} onChange={setView} />
      {view === "by_provider" && (
        <ByProvider rows={summary} unbilled={unbilled} stuck={stuck} />
      )}
      {view === "all_unbilled" && <AllUnbilled rows={unbilled} />}
      {view === "all_stuck" && <AllStuck rows={stuck} />}
      {view === "aging_matrix" && <AgingMatrix rows={aging} />}
    </div>
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
}: {
  rows: SummaryRow[];
  unbilled: UnbilledRow[];
  stuck: StuckRow[];
}) {
  const unbilledCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of unbilled) {
      if (!r.provider_id) continue;
      m.set(r.provider_id, (m.get(r.provider_id) ?? 0) + 1);
    }
    return m;
  }, [unbilled]);

  const stuckCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of stuck) {
      if (!r.provider_id) continue;
      m.set(r.provider_id, (m.get(r.provider_id) ?? 0) + 1);
    }
    return m;
  }, [stuck]);

  if (rows.length === 0) {
    return (
      <EmptyState message="No active HMO providers." />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => (
        <ProviderCard
          key={r.provider_id ?? r.provider_name ?? "row"}
          row={r}
          unbilledCount={
            r.provider_id ? (unbilledCounts.get(r.provider_id) ?? 0) : 0
          }
          stuckCount={
            r.provider_id ? (stuckCounts.get(r.provider_id) ?? 0) : 0
          }
        />
      ))}
    </div>
  );
}

function ProviderCard({
  row,
  unbilledCount,
  stuckCount,
}: {
  row: SummaryRow;
  unbilledCount: number;
  stuckCount: number;
}) {
  const href = row.provider_id
    ? `/staff/admin/accounting/hmo-claims/${row.provider_id}`
    : "#";
  const unresolved = row.total_unresolved_ar_php ?? 0;
  const unbilled = row.total_unbilled_php ?? 0;
  const stuck = row.total_stuck_php ?? 0;
  const oldest = row.oldest_open_released_at
    ? new Date(row.oldest_open_released_at).toLocaleDateString("en-PH")
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

function AllUnbilled({ rows }: { rows: UnbilledRow[] }) {
  if (rows.length === 0) {
    return <EmptyState message="Nothing unbilled." />;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3">Provider</th>
            <th className="px-4 py-3">Released</th>
            <th className="px-4 py-3 text-right">Age (days)</th>
            <th className="px-4 py-3 text-right">Amount</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.test_request_id ?? `${r.visit_id}-${r.released_at}`}
              className={
                "border-t border-[color:var(--color-brand-bg-mid)] " +
                (r.past_threshold ? "bg-amber-50" : "")
              }
            >
              <td className="px-4 py-3">{r.provider_name ?? "—"}</td>
              <td className="px-4 py-3 text-xs">
                {r.released_at
                  ? new Date(r.released_at).toLocaleDateString("en-PH")
                  : "—"}
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
                    Open provider
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AllStuck({ rows }: { rows: StuckRow[] }) {
  if (rows.length === 0) {
    return <EmptyState message="Nothing stuck." />;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3">Provider</th>
            <th className="px-4 py-3">Submitted</th>
            <th className="px-4 py-3 text-right">Days late</th>
            <th className="px-4 py-3 text-right">Unresolved</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.item_id ?? `${r.batch_id}-${r.submitted_at}`}
              className="border-t border-[color:var(--color-brand-bg-mid)] bg-red-50"
            >
              <td className="px-4 py-3">{r.provider_name ?? "—"}</td>
              <td className="px-4 py-3 text-xs">
                {r.submitted_at
                  ? new Date(r.submitted_at).toLocaleDateString("en-PH")
                  : "—"}
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
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

  if (matrix.length === 0) {
    return <EmptyState message="No aging data." />;
  }

  return (
    <>
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
